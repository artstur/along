// web/app.mjs 在模块顶层就访问 document / localStorage / window，Node 里没法直接 import。
// 这个最小 DOM 桩只为把 app.mjs 拉起来，好让它的真实接线（渲染、点击、提交）能被自动化测试钉住。
// 桩不实现布局与事件派发，只保留 app.mjs 真正用到的那几个接口。

class StubElement {
  constructor(tag='div') {
    this.tagName=tag;
    this.innerHTML='';
    this.textContent='';
    this.dataset={};
    this.style={setProperty(){}};
    this.classList={add(){},remove(){},contains(){return false;}};
    this.listeners={};
    this.queries=new Map();
    this.inserted=[];
    this.scrollTop=0;
    this.scrollHeight=0;
    this.clientHeight=0;
  }
  addEventListener(type,handler) { (this.listeners[type] ||= []).push(handler); }
  async dispatch(type,event={}) { for (const handler of this.listeners[type]||[]) await handler(event); }
  querySelector(selector) {
    if (!this.queries.has(selector)) this.queries.set(selector,new StubElement());
    return this.queries.get(selector);
  }
  querySelectorAll() { return []; }
  insertAdjacentHTML(position,html) { this.inserted.push({position,html}); }
  remove() {}
  scrollTo() {}
  click() {}
  showModal() {}
  close() {}
  setAttribute() {}
  getAttribute() { return null; }
  focus() {}
  blur() {}
}

class StubFormData {
  constructor(form) { this.form=form; }
  get(name) { return this.form?.fields?.[name] ?? null; }
}

export function installDomStub({storage={}}={}) {
  const store=new Map(Object.entries(storage));
  const elements=new Map();
  const document={
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector,new StubElement());
      return elements.get(selector);
    },
    documentElement:{style:{setProperty(){}}},
    addEventListener(){},
  };
  const localStorage={
    getItem:key=>store.has(key)?store.get(key):null,
    setItem:(key,value)=>{ store.set(key,String(value)); },
    removeItem:key=>{ store.delete(key); },
    clear:()=>{ store.clear(); },
  };
  const windowListeners=new Map();
  const window={
    innerHeight:800,
    visualViewport:{height:800,addEventListener(){}},
    addEventListener(type,handler){ const list=windowListeners.get(type)||[]; list.push(handler); windowListeners.set(type,list); },
    scrollTo(){},
  };
  globalThis.document=document;
  globalThis.localStorage=localStorage;
  globalThis.window=window;
  globalThis.history={};
  globalThis.location={hostname:'localhost'};
  globalThis.requestAnimationFrame=fn=>{ fn(); return 0; };
  globalThis.FormData=StubFormData;
  globalThis.fetch=async()=>{ throw Error('DOM 桩不提供网络'); };
  // app.mjs 里最长的定时器是 toast 自动消失（3.2 秒），会让测试进程白等；长延时统一压到 1 毫秒。
  const nativeSetTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(fn,delay,...args)=>nativeSetTimeout(fn,delay>=1000?1:delay,...args);
  // app.mjs 有几个 60 秒/4 秒/3 秒的轮询定时器，测试里默认不跑，也不能让进程无法退出；
  // 需要验证轮询行为时用 tick(毫秒) 手动触发对应的那一个。
  const intervals=[];
  globalThis.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length;};
  const app=document.querySelector('#app');
  return {
    app,
    store,
    intervals,
    async tick(ms) { for (const entry of intervals) if (entry.ms===ms) await entry.fn(); },
    // 触发 window 上的监听器：app.mjs 的健康更新、页面可见性等都挂在这里。
    fireWindow(type,event={}) { const list=windowListeners.get(type)||[]; return Promise.all(list.map(handler=>handler(event))); },
    storage:{get:key=>store.get(key)??null,set:(key,value)=>store.set(key,String(value))},
    click(dataset,extra={}) {
      return app.dispatch('click',{target:{closest:()=>({dataset})},...extra});
    },
    submit(form) {
      return app.dispatch('submit',{target:{id:'agent-form',fields:{message:'继续'},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
    },
  };
}
