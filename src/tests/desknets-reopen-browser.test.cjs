// Browser interaction regression. No live calendar writes or registrations.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext();
    const page=await context.newPage();
    let handoffs=0;
    await context.route('https://handoff.test/**', route => {
      if(route.request().url().includes('/api/desknets-agent/')) {
        handoffs++;
        return route.fulfill({contentType:'application/json',body:JSON.stringify({handoffUrl:"https://desknets.midac.jp/dneo/dneo.cgi?cmd=schindex#cmd=schaddtarget&date=20990918&enddate=20990918&starttime=1400&endtime=1500&id=186&id=5&id=6"})});
      }
      return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
    });
    await context.route('https://desknets.midac.jp/**',route=>route.fulfill({contentType:'text/html',body:'Draft only'}));
    await page.goto('https://handoff.test/');
    await page.addScriptTag({path:path.join(path.dirname(require.resolve('react')),'umd/react.development.js')});
    await page.addScriptTag({path:path.join(path.dirname(require.resolve('react-dom')),'umd/react-dom.development.js')});
    const code=ts.transpileModule(readFileSync('features/desknets-agent/desknets-approval-card.tsx','utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true},
    }).outputText;
    await page.evaluate(code=>{
      const loaded={exports:{}};
      const react=window.React;
      const req=name=>{
        if(name==='react')return react;
        if(name==='lucide-react')return {RotateCcw:()=>null};
        if(name==='@/features/chat-page/chat-store')return {chatStore:{submitText:()=>{}}};
        throw Error(name);
      };
      Function('require','exports','module','React',code)(req,loaded.exports,loaded,react);
      const toolResult={runId:'test-run',chatThreadId:'test-thread',approvalRequest:{title:'打ち合わせ',
        start:'2099-09-18T05:00:00Z',end:'2099-09-18T06:00:00Z',participantIds:['本人','参加者B','参加者C'],
        facilityId:'会議室C',emailNotificationWillBeSent:true}};
      window.ReactDOM.createRoot(document.getElementById('root')).render(react.createElement(loaded.exports.DeskNetsApprovalCard,{toolResult}));
    },code);
    const button=page.getByRole('button',{name:"desknet'sを開く",exact:true});
    for(let i=0;i<2;i++) {
      const popupPromise=context.waitForEvent('page');
      await button.click();
      const popup=await popupPromise;
      await popup.waitForURL('https://desknets.midac.jp/**');
      assert.match(popup.url(),/id=186&id=5&id=6/);
      await popup.close();
      await button.waitFor({state:'visible'});
    }
    assert.equal(handoffs,2);
    assert.equal(await page.getByRole('button',{name:'議題をコピー'}).count(),0);
    assert.equal(await page.getByRole('button',{name:/実行側Edge/}).count(),0);
    console.log('PASS: actual button opens, closes and reopens a fresh draft tab; removed controls absent.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
