import React, { useState } from 'react';
import { TOOL_TYPES, turnPresentation, type TranscriptTurn } from './transcript';
import type { SessionEvent } from './api/types';

export type DetailMode = 'compact' | 'standard' | 'detailed' | 'verbose';
export const DETAIL_MODES: Record<DetailMode, string> = { compact: '简洁', standard: '标准', detailed: '详细', verbose: '完全展开' };
export function TurnView({ turn, mode, render }: { turn: TranscriptTurn; mode: DetailMode; render(event: SessionEvent, expanded: boolean): React.ReactNode }) {
  const { prompts, process, final } = turnPresentation(turn);
  const [chosenOpen, setChosenOpen] = useState<boolean>();
  const attention = turn.status === 'failed' || turn.status === 'interrupted' || process.some(r => r.event.type === 'error'
    || r.event.payload.status === 'failed' || typeof r.event.payload.exitCode === 'number' && r.event.payload.exitCode !== 0);
  const expanded = mode === 'verbose';
  const open = expanded || (chosenOpen ?? (attention || turn.status === 'running' || turn.status === 'unknown' || mode === 'detailed'));
  const tools = process.filter(r => TOOL_TYPES.has(r.event.type)).length;
  const label = { running: '正在执行', completed: '已完成', failed: '执行失败', interrupted: '已中断', unknown: '执行记录' }[turn.status];
  const duration = turn.durationMs === undefined ? '' : ` · 用时 ${turn.durationMs < 1000 ? '<1 秒' : `${Math.round(turn.durationMs / 1000)} 秒`}`;
  if (!prompts.length && !process.length && !final) return null;
  return <section className={`execution-turn ${attention ? 'needs-attention' : ''}`}>
    {prompts.map(row => <React.Fragment key={row.key}>{render(row.event, expanded)}</React.Fragment>)}
    {process.length > 0 ? <div className="turn-work">
      <button type="button" className="turn-summary" aria-expanded={open} onClick={() => setChosenOpen(!open)} disabled={expanded}>
        <span aria-hidden="true">{open ? '⌄' : '›'}</span><strong>{label}</strong>
        <span>{tools ? `${tools} 次工具调用` : '执行过程'}{duration}{turn.partial ? ' · 部分记录' : ''}</span>
      </button>
      {open && <div className={`turn-steps mode-${mode}`}>{process.map((row, i) => <div className="turn-step" key={row.key}>
        {mode !== 'compact' && <span className="step-number" aria-label={`步骤 ${i + 1}`}>{i + 1}</span>}
        <div>{render(row.event, expanded)}</div>
      </div>)}</div>}
    </div> : turn.status !== 'unknown' && <div className="turn-caption">{label}{duration}</div>}
    {final && render(final.event, expanded)}
  </section>;
}
