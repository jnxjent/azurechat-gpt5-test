"use client";
// Kept in this iframe's memory, never in URLs, cookies or persistent storage.
let dialogToken:string|undefined;
export function setCanvasDialogToken(token:string){dialogToken=token;}
export function canvasFetch(input:string,init:RequestInit={}) {
  const headers=new Headers(init.headers);
  if(dialogToken&&input.startsWith("/api/canvas/shared/"))headers.set("Authorization",`Bearer ${dialogToken}`);
  return fetch(input,{...init,headers,cache:"no-store"});
}
