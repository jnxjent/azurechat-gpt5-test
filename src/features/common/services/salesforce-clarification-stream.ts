import "server-only";
import { ChatCompletionStreamingRunner } from "openai/resources/beta/chat/completions";

/** Display the Gateway's validated question verbatim, without a second model. */
export function salesforceClarificationStream(question:string,signal:AbortSignal):ChatCompletionStreamingRunner {
  const text=`検索条件の確認：\n\n${question.slice(0,400)}`;
  const base={id:"gateway-clarification",object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"gateway-clarification"};
  const stream=new ReadableStream<Uint8Array>({start(controller){
    const encoder=new TextEncoder();
    controller.enqueue(encoder.encode(JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:null}]})+"\n"));
    controller.enqueue(encoder.encode(JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}]})+"\n"));
    controller.close();
  }});
  const runner=ChatCompletionStreamingRunner.fromReadableStream(stream);
  const abort=()=>runner.abort();
  if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
  runner.once("end",()=>signal.removeEventListener("abort",abort));
  return runner;
}
