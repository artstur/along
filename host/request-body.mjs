import {StringDecoder} from 'node:string_decoder';
// 逐块 toString 会把跨 TCP 段的中文多字节字符切坏：每个 chunk 单独解码，
// 半个汉字变成 U+FFFD（���），用户的中文目标到模型手里就是乱码。
// StringDecoder 会跨块保留不完整的字节序列，最后一次性解完。
export async function readJsonBody(req,maxBytes) {
  const decoder=new StringDecoder('utf8');
  let text='',size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>maxBytes) throw Error('请求过大');
    text+=decoder.write(chunk);
  }
  return JSON.parse(text+decoder.end());
}
