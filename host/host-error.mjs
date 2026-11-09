// 上游（DSH / Kimi / 模型）出的问题不是客户端请求不合法：要答复 5xx。
// 400 会把「对方挂了」和「我发错了」在客户端混成同一件事。
export class HostError extends Error {
  constructor(message,status=502) { super(message); this.status=status; }
}
// 上游调用统一包一层：失败按上游故障答复，不当成客户端请求不合法。
export async function upstream(operation) {
  try { return await operation(); }
  catch(error) { throw error instanceof HostError ? error : new HostError(error?.message??String(error),502); }
}
export function statusForError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (String(error?.message??'').includes('正在处理')) return 429;
  return 400;
}
