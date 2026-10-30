/** Wait for a backend's real terminal event; sending cancel is not proof of settlement. */
export async function waitForTurnSettlement(current: () => string | undefined, turnId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (current() === turnId) {
    if (Date.now() >= deadline) throw Object.assign(new Error("停止请求已发送，但尚未确认旧 turn 结束；未启动新 turn"),
      { code: "interrupt_unconfirmed", retryable: false });
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 25); timer.unref(); });
  }
}
