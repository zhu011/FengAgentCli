// 装载门测试夹具：apply 正常返回但什么都不注册（工具增量门应报错）
export const name = "dsh-fixture-empty";
export const inject = ["tools"];

export function apply(_ctx, _config) {
  // 故意不注册任何工具
}
