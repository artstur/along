export const recommendation=()=>({version:1,kind:'hiking',status:'ready',title:'周末徒步方案',summary:'结合时间窗口，先比较两条路线。',timeWindow:'周末白天',constraints:['公共交通可达'],
  options:[{id:'option_one',title:'合成公园路线',reason:'适合较短的休闲徒步',status:'recommended',conditions:['出发前再查天气'],unknowns:[],
    facts:[{label:'步道长度',value:'官方公开步道约3公里',sourceIds:['source_access']}],checks:[
      {kind:'access',status:'ok',summary:'开放信息已取得',sourceIds:['source_access']},
      {kind:'weather',status:'ok',summary:'已查询当前天气信息',sourceIds:['source_weather']}],sourceIds:['source_access','source_weather']}],
  sources:[{id:'source_access',title:'公园官方路线',url:'https://www.gz.gov.cn/route',retrievedAt:'2099-01-01T00:00:00Z',expiresAt:'2099-01-02T00:00:00Z'},
    {id:'source_weather',title:'气象台天气',url:'https://www.gd121.cn/weather',retrievedAt:'2099-01-01T00:00:00Z',expiresAt:'2099-01-01T06:00:00Z'}],
  retrievedAt:'2099-01-01T00:00:00Z',validUntil:'2099-01-01T06:00:00Z',nextStep:'告诉我更倾向哪条路线，我会继续核对。'});
