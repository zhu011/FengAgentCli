/**
 * @fengagent/dsh-compat — `ctx.fs` 兼容面验收（P3 收尾）
 *
 * 覆盖 `dsh-better-edit` / `dsh-tool-fs` 真实用到的面：resolve/processPath/stat/
 * readText/readBytes/writeText/editText/listDir，以及 `FS_*` 错误码与版本守卫。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsShimError, LocalFileSystemCompat, type FsErrorCode } from "../fs.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-fs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 断言抛出的是带指定 code 的 FsShimError */
function expectCode(fn: () => Promise<unknown>, code: FsErrorCode): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected ${code}, but the call resolved`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(FsShimError);
      expect((error as FsShimError).code).toBe(code);
    },
  );
}

describe("fs：解析与元数据", () => {
  test("resolve 相对路径按 cwd 解析；processPath/fileUrl/contains 一致", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    const target = await fs.resolve("a/b.txt", { cwd: dir });

    expect(fs.processPath(target)).toBe(join(dir, "a", "b.txt"));
    expect(fs.fileUrl(target)).toStartWith("file:///");
    expect(fs.contains(await fs.resolve(dir), target)).toBe(true);
    expect(fs.contains(await fs.resolve(join(dir, "a")), target)).toBe(true);
    expect(fs.contains(target, await fs.resolve(dir))).toBe(false);
    expect(fs.sandboxMode).toBeUndefined();
  });

  test("stat 缺失返回 undefined；存在返回 file/directory + size + version", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    writeFileSync(join(dir, "x.txt"), "hello", "utf8");

    expect(await fs.stat(await fs.resolve(join(dir, "missing.txt")))).toBeUndefined();
    const file = await fs.stat(await fs.resolve(join(dir, "x.txt")));
    expect(file?.type).toBe("file");
    expect(file?.size).toBe(5);
    expect(file?.version).toMatch(/^5:\d+$/);

    const folder = await fs.stat(await fs.resolve(dir));
    expect(folder?.type).toBe("directory");
  });

  test("listDir 按名字排序、只给元数据", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    writeFileSync(join(dir, "b.txt"), "b", "utf8");
    writeFileSync(join(dir, "a.txt"), "a", "utf8");

    const entries = await fs.listDir(await fs.resolve(dir));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
    expect(entries[0]?.type).toBe("file");
    expect(entries[0]?.size).toBe(1);
  });
});

describe("fs：读", () => {
  test("readText 严格 UTF-8；缺失 → FS_NOT_FOUND，目录 → FS_NOT_REGULAR_FILE，二进制 → FS_NOT_TEXT", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    writeFileSync(join(dir, "ok.txt"), "你好, dsh", "utf8");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    expect(await fs.readText(await fs.resolve(join(dir, "ok.txt")))).toBe("你好, dsh");
    const missing = await fs.resolve(join(dir, "nope.txt"));
    const folder = await fs.resolve(dir);
    const binary = await fs.resolve(join(dir, "bin.dat"));
    await expectCode(() => fs.readText(missing), "FS_NOT_FOUND");
    await expectCode(() => fs.readText(folder), "FS_NOT_REGULAR_FILE");
    await expectCode(() => fs.readText(binary), "FS_NOT_TEXT");
  });

  test("readBytes 受 maxBytes 约束；readByteRange 只读区间", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    writeFileSync(join(dir, "data.bin"), Buffer.from("0123456789"), "utf8");
    const target = await fs.resolve(join(dir, "data.bin"));

    const all = await fs.readBytes(target, undefined, 10);
    expect(Buffer.from(all).toString("utf8")).toBe("0123456789");
    await expectCode(() => fs.readBytes(target, undefined, 9), "FS_TOO_LARGE");

    const range = await fs.readByteRange(target, { offset: 2, length: 3 });
    expect(Buffer.from(range).toString("utf8")).toBe("234");
  });
});

describe("fs：写与编辑", () => {
  test("writeText：create → update 的版本与 before/after 语义", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    const target = await fs.resolve(join(dir, "nested", "out.txt"));

    const created = await fs.writeText(target, "v1");
    expect(created.operation).toBe("create");
    expect(created.before).toBeNull();
    expect(created.after).toBe("v1");

    // Windows 计时分辨率下两次写可能同 tick（size 相同 → 版本碰撞），隔开保证 mtime 推进
    await new Promise((r) => setTimeout(r, 5));
    const updated = await fs.writeText(target, "v2");
    expect(updated.operation).toBe("update");
    expect(updated.before).toBe("v1");
    expect(updated.after).toBe("v2");
    expect(updated.version).not.toBe(created.version);
    expect(await fs.readText(target)).toBe("v2");
  });

  test("writeText 守卫：createIfAbsent → FS_NOT_OBSERVED；replaceIfVersion 陈旧/缺失 → FS_STALE_VERSION", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    const target = await fs.resolve(join(dir, "guard.txt"));

    const first = await fs.writeText(target, "one", { kind: "createIfAbsent" });
    await expectCode(
      () => fs.writeText(target, "two", { kind: "createIfAbsent" }),
      "FS_NOT_OBSERVED",
    );

    await fs.writeText(target, "three", { kind: "replaceIfVersion", version: first.version });
    await expectCode(
      () => fs.writeText(target, "four", { kind: "replaceIfVersion", version: first.version }),
      "FS_STALE_VERSION",
    );
    const absent = await fs.resolve(join(dir, "absent.txt"));
    await expectCode(
      () => fs.writeText(absent, "x", { kind: "replaceIfVersion", version: "0:0" }),
      "FS_STALE_VERSION",
    );
  });

  test("editText：唯一匹配替换 / replaceAll / 无匹配 / 多处歧义 / 版本守卫", async () => {
    const dir = tempDir();
    const fs = new LocalFileSystemCompat();
    writeFileSync(join(dir, "edit.txt"), "foo bar foo", "utf8");
    const target = await fs.resolve(join(dir, "edit.txt"));

    await expectCode(
      () => fs.editText(target, { oldString: "foo", newString: "X", replaceAll: false }),
      "FS_AMBIGUOUS_EDIT",
    );
    await expectCode(
      () => fs.editText(target, { oldString: "zzz", newString: "X", replaceAll: false }),
      "FS_EDIT_NOT_FOUND",
    );

    const one = await fs.editText(target, { oldString: "bar", newString: "BAR", replaceAll: false });
    expect(one.after).toBe("foo BAR foo");
    expect(one.before).toBe("foo bar foo");

    const all = await fs.editText(target, { oldString: "foo", newString: "z", replaceAll: true });
    expect(all.after).toBe("z BAR z");

    await expectCode(
      () =>
        fs.editText(
          target,
          { oldString: "z", newString: "y", replaceAll: true },
          { version: "stale" },
        ),
      "FS_STALE_VERSION",
    );
  });
});
