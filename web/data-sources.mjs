// Provider actions are application capabilities, never URLs invented by a model.
const CATALOG=Object.freeze({
  okx:Object.freeze({name:'OKX',symbol:'O',url:'https://www.okx.com/account/my-api',action:'前往 OKX 设置',
    detail:'只读接入 · 尚未连接'}),
  'apple-health':Object.freeze({name:'Apple Health',symbol:'♥'}),
});

export const dataSourceProvider=provider=>Object.hasOwn(CATALOG,provider)?CATALOG[provider]:null;

export function safeDataSources(value) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>2)throw Error('数据源同步格式不正确');
  const seen=new Set();
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||!dataSourceProvider(item.provider)||
        item.status!=='recommended'||typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>240||
        Object.keys(item).some(key=>!['provider','status','reason'].includes(key))||seen.has(item.provider)) {
      throw Error('数据源同步格式不正确');
    }
    seen.add(item.provider);
    return {provider:item.provider,status:'recommended',reason:item.reason.trim()};
  });
}
