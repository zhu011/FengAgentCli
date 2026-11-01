/**
 * @fengagent/group-plugin — 便携群存储的 V2-3 字段（`speechMode`）
 *
 * 插件侧（dsh / 非 Bun 运行时）用 JSON store，与 SQLite 版 `AgentGroupStore` 同语义：
 * - 建群缺省 `coordinated`（v1 兼容），可显式 `free`；
 * - 老存档（没有 `speechMode` 字段）读出时补 `coordinated`，不被当成 free。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableGroupStore } from "../portable-store.ts";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "feng-portable-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PortableGroupStore — speechMode（V2-3）", () => {
  test("建群缺省 coordinated，free 可存可读", () => {
    withDir((dir) => {
      const store = new PortableGroupStore(dir);
      const plain = store.create({ name: "缺省", members: [] });
      expect(plain.speechMode).toBe("coordinated");

      const free = store.create({ name: "自治", members: [], speechMode: "free" });
      expect(free.speechMode).toBe("free");
      expect(store.get(free.id)!.speechMode).toBe("free");

      expect(store.update(free.id, { speechMode: "coordinated" }).speechMode).toBe("coordinated");
      store.close();
    });
  });

  test("老 JSON（没有 speechMode 字段）读出补 coordinated", () => {
    withDir((dir) => {
      const legacy = {
        groups: [
          {
            id: "grp_old",
            name: "老群",
            description: "",
            status: "open",
            members: [{ kind: "coordinator", name: "fengagent", runtime: "fengagent" }],
            coordinator: "fengagent",
            maxRounds: 3,
            idleTimeoutMs: 600_000,
            createdAt: 1,
            updatedAt: 1,
            createdBy: "dashboard",
          },
        ],
        messages: [],
      };
      writeFileSync(join(dir, "groups.json"), JSON.stringify(legacy));

      const store = new PortableGroupStore(dir);
      expect(store.get("grp_old")!.speechMode).toBe("coordinated");
      store.close();
    });
  });
});
