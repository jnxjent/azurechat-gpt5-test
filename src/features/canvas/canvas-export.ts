"use client";
/** Build export DOM with textContent/cloneNode, never interpolate report HTML. */
export function printCanvas(element:HTMLElement, title:string) {
  const popup=window.open("","_blank","width=1000,height=800");
  if(!popup)throw Error("印刷画面を開けません。ポップアップを許可してください。");
  popup.opener=null;
  const page=popup.document;
  page.title=title;
  const style=page.createElement("style");
  style.textContent="body{font:14px sans-serif;color:#111;background:white;padding:24px;line-height:1.7}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px}svg{width:100%;color:#111}button,input,select,textarea,[data-no-export]{display:none}article,fieldset{border:0;margin-bottom:24px}a{color:#111} @page{margin:15mm} @media print{svg,tr{break-inside:avoid}}";
  page.head.append(style);
  page.body.append(element.cloneNode(true));
  popup.setTimeout(()=>{popup.focus();popup.print();},300);
}
export async function exportCanvasChart(svg:SVGSVGElement, title:string, metadata:string) {
  const clone=svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
  clone.setAttribute("width","1520");clone.setAttribute("height","560");clone.style.color="#111";clone.style.background="white";
  const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:"image/svg+xml;charset=utf-8"}));
  try {
    const image=new Image();image.src=url;await image.decode();
    const lines=[title,...(metadata.match(/.{1,85}/g)??[])];
    const canvas=document.createElement("canvas");canvas.width=1520;canvas.height=620+lines.length*30;
    const context=canvas.getContext("2d");if(!context)throw Error("画像を作成できません。");
    context.fillStyle="white";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0);
    context.fillStyle="#111";context.font="22px sans-serif";lines.forEach((line,i)=>context.fillText(line,30,590+i*30));
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error("画像を作成できません。")),"image/png"));
    const download=URL.createObjectURL(blob),link=document.createElement("a");link.href=download;link.download="canvas-chart.png";link.click();setTimeout(()=>URL.revokeObjectURL(download),1000);
  }finally{URL.revokeObjectURL(url);}
}
