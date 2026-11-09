import {StringDecoder} from 'node:string_decoder';
// 逐块 toString 会把跨 TCP 段的中文多字节字符切坏：每个 chunk 单独解码，
// 半个汉字变成 U+FFFD（���），用户的中文目标到模型手里就是乱码。
// StringDecoder 会跨块保留不完整的字节序列，最后一次性解完。
// 上限按字符算（和原来一样）：中文一个字是三个字节，按字节算会让一次
// 正常的中文长对话被判「请求过大」。
export async function readJsonBody(req,maxChars) {
  const decoder=new StringDecoder('utf8');
  let text='';
  for await (const chunk of req) { text+=decoder.write(chunk); if (text.length>maxChars) throw Error('请求过大'); }
  return JSON.parse(text+decoder.end());
}
