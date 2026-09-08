import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mod from "../../src/renderer/hooks/useAgentTranscript";

/**
 * 回合现场 store（渲染层模块级单例）的行为锁定测试。
 * 规范：docs/agent-live-transcript-spec.md
 * 钉死的正是这次修的两个用户可感问题：① 切页/切会话回来现场不丢；② 事件按会话归属，不串台。
 * 另加思考逐字生长（reasoning_delta 累积 → 整块封口成一张卡）与排队续发。
 */

type Handler = (data: unknown) => void;

const channels = new Map<string, Handler[]>();
const invoke = vi.fn();
const dispatched: string[] = [];

function emit(channel: string, data: unknown): void {
  for (const h of channels.get(channel) ?? []) h(data);
}

/** 渲染层环境替身：store 只用 window.api.on/invoke、window.location.hash、window.dispatchEvent */
function installWindow(): void {
  const w = {
    api: {
      on: (channel: string, cb: Handler) => {
        channels.set(channel, [...(channels.get(channel) ?? []), cb]);
        return () => {
          channels.set(channel, (channels.get(channel) ?? []).filter(h => h !== cb));
        };
      },
      invoke,
    },
    location: { hash: "#/assistant" },
    dispatchEvent: (ev: { type?: string }) => { dispatched.push(ev?.type ?? ""); return true; },
  };
  (globalThis as { window?: unknown }).window = w;
}

installWindow();

const flush = () => new Promise(resolve => { setTimeout(resolve, 0); });
const activeConvId = (): string | undefined =>
  /c=([^&]+)/.exec(String((globalThis as { window: { location: { hash: string } } }).window.location.hash))?.[1];

async function openConversation(id: string | undefined, rows: unknown[] = []): Promise<void> {
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(channel === "agent:getConversation" ? { success: true, data: rows } : { success: true, data: {} }));
  mod.navigate(id, undefined);
  await flush();
  invoke.mockReset();
  invoke.mockImplementation((_channel: string) => Promise.resolve({ success: true, data: { conversationId: "x", messageId: "m" } }));
}

const { NEW_KEY } = mod;

beforeEach(() => {
  dispatched.length = 0;
});

// 假计时器一旦漏恢复，后面每条用例都会卡在 setTimeout 上超时 —— 每条跑完强制还原
afterEach(() => { vi.useRealTimers(); });

describe("agent 回合现场 store", () => {
  it("① 页面不在（无订阅者）时事件仍累积，回来读到完整现场并继续生长", async () => {
    const id = "conv-live";
    await openConversation(id);
    const sent = mod.send(id, "这条会切页");
    await sent;
    emit("agent:chunk", { conversationId: id, delta: "你" });
    emit("agent:toolCall", { conversationId: id, tool: "quote_search", callId: "c1", status: "calling", args: '{"pod":"santos"}' });
    emit("agent:chunk", { conversationId: id, delta: "好" });

    const conv = mod.getConv(id);
    expect(conv.sending).toBe(true);                       // 回合还在跑，现场不能被清空
    const ai = conv.messages.filter(m => m.role === "ai").at(-1)!;
    expect(ai.content).toBe("你好");
    const chip = conv.messages.find(m => m.chip?.kind === "calling")!;
    expect(chip.chip?.args).toContain("pod=santos");
  });

  it("② done 只收尾不清场；后续再打开该会话仍是同一份现场", async () => {
    const id = "conv-done";
    await openConversation(id);
    await mod.send(id, "问一句");
    emit("agent:chunk", { conversationId: id, delta: "答一句" });
    emit("agent:done", { conversationId: id, usage: { requests: 1, input: 10, output: 5 } });

    const conv = mod.getConv(id);
    expect(conv.sending).toBe(false);
    expect(conv.messages.some(m => m.role === "ai" && m.content === "答一句")).toBe(true);
    expect(conv.sessionUsage).toEqual({ input: 10, output: 5 });
    expect(conv.messages.at(-1)!.streaming).toBeFalsy();
  });

  it("③ 事件按 conversationId 归属，后台会话的增量不会画进前台会话", async () => {
    const bg = "conv-bg";
    await openConversation(bg);
    await mod.send(bg, "后台问题");
    const fg = "conv-fg";
    await openConversation(fg);
    await mod.send(fg, "前台问题");

    emit("agent:chunk", { conversationId: bg, delta: "后台的回答" });

    expect(mod.getConv(fg).messages.some(m => m.content.includes("后台的回答"))).toBe(false);
    expect(mod.getConv(bg).messages.some(m => m.content.includes("后台的回答"))).toBe(true);
  });

  it("④ 思考逐字生长成一张卡，整块定稿时封口而不是另起一张", async () => {
    const id = "conv-think";
    await openConversation(id);
    await mod.send(id, "想久一点");

    emit("agent:toolCall", { conversationId: id, tool: "reasoning", status: "reasoning_delta", delta: "先看航线" });
    emit("agent:toolCall", { conversationId: id, tool: "reasoning", status: "reasoning_delta", delta: "再比台账价" });
    let thinkChips = mod.getConv(id).messages.filter(m => m.chip?.kind === "reasoning");
    expect(thinkChips).toHaveLength(1);
    expect(thinkChips[0]!.chip?.detail).toBe("先看航线再比台账价");
    expect(thinkChips[0]!.chip?.live).toBe(true);

    emit("agent:toolCall", { conversationId: id, tool: "reasoning", callId: "r1", status: "reasoning", result: "先看航线再比台账价，最后给结论。" });
    thinkChips = mod.getConv(id).messages.filter(m => m.chip?.kind === "reasoning");
    expect(thinkChips).toHaveLength(1);
    expect(thinkChips[0]!.chip?.live).toBe(false);
    expect(thinkChips[0]!.chip?.detail).toContain("最后给结论");
  });

  it("⑤ 生成中再来一条 = 豆包式插队：走 stop 打断 + 空闲后发第二条", async () => {
    const id = "conv-queue";
    await openConversation(id);        // 先装会话：flush 用的是真 setTimeout，假计时器会把它冻住
    vi.useFakeTimers();
    await mod.send(id, "第一条");
    expect(mod.getConv(id).sending).toBe(true);

    // 页面层语义：sending 时 handleSend → stopTurn + whenIdle + sendTurn。
    // store 层验证：stop 走 agent:stop 且不再有排队态；空闲后第二条正常进管线。
    mod.stop(id);
    expect(invoke.mock.calls.some(c => c[0] === "agent:stop")).toBe(true);
    expect(mod.getConv(id).queued).toBeUndefined();          // 排队机制已移除

    emit("agent:done", { conversationId: id, stopped: true });
    await vi.advanceTimersByTimeAsync(100);                  // 冲刷 whenIdle 轮询
    expect(mod.getConv(id).sending).toBe(false);
    await mod.send(id, "第二条");
    const calls = invoke.mock.calls.filter(c => c[0] === "agent:chat");
    expect(calls).toHaveLength(2);
    expect((calls[1]![1] as { text: string }).text).toBe("第二条");
  });

  it("⑥ 新草稿发送时定住真实 id，事件按该 id 接得上（首包前切页也不丢第一条）", async () => {
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === "agent:getConversation" ? { success: true, data: [] } : { success: true, data: {} }));
    mod.navigate(undefined, undefined);
    mod.resetDraft();
    invoke.mockReset();
    invoke.mockImplementation((_c: string) => Promise.resolve({ success: true, data: { conversationId: "x", messageId: "m" } }));

    await mod.send(NEW_KEY, "开个头");
    const id = activeConvId();
    expect(id).toBeTruthy();
    expect(mod.getConv(NEW_KEY).messages).toHaveLength(0);   // 草稿条目已搬走，不留半截现场

    emit("agent:chunk", { conversationId: id, delta: "接得上" });
    expect(mod.getConv(id!).messages.some(m => m.content === "接得上")).toBe(true);
  });

  it("⑦ 审批卡随会话存在，切走再回来还能确认；拒绝后仍等续跑 done", async () => {
    const id = "conv-approve";
    await openConversation(id);
    await mod.send(id, "记一条跟进");
    emit("agent:approval", { conversationId: id, approvalId: "a1", items: [{ tool: "record_followup", args: {} }] });
    expect(mod.getConv(id).approval?.approvalId).toBe("a1");

    await openConversation("conv-elsewhere");                 // 切去看别的会话
    expect(mod.getConv(id).approval?.approvalId).toBe("a1");  // 现场仍挂着，不会因换视图丢掉

    await mod.resolveApproval(id, true);
    expect(mod.getConv(id).approval).toBeNull();
    expect(invoke.mock.calls.some(c => c[0] === "agent:resolveApproval")).toBe(true);
    // 载荷锁死：会话豁免已删，不得再有 rememberTool 之类的"记住这次批准"参数
    expect(invoke.mock.calls.find(c => c[0] === "agent:resolveApproval")?.[1])
      .toEqual({ approvalId: "a1", approved: true });
    expect(mod.getConv(id).sending).toBe(true);               // 续跑的 done 还没来，回合不算结束
  });

  it("⑧ 错误落点在气泡上，回合正常收尾", async () => {
    const id = "conv-error";
    await openConversation(id);
    await mod.send(id, "问一句");
    emit("agent:error", { conversationId: id, message: "模型调用失败: 余额不足" });

    const conv = mod.getConv(id);
    expect(conv.sending).toBe(false);
    expect(conv.messages.at(-1)).toMatchObject({ role: "ai", error: true, content: "模型调用失败: 余额不足" });
  });

  it("⑨ 删除会话连带清掉现场缓存", async () => {
    const id = "conv-drop";
    await openConversation(id);
    await mod.send(id, "说两句");
    expect(mod.getConv(id).messages.length).toBeGreaterThan(0);
    mod.drop(id);
    expect(mod.getConv(id).messages).toHaveLength(0);
  });
});
