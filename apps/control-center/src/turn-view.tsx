import React, { useState } from 'react';
import { entryStatus, type EntryView, type ViewItem } from '@agent-bridge/transcript';
import type { Session } from './api/types';

export type DetailMode = 'compact' | 'standard' | 'detailed' | 'verbose';
export const DETAIL_MODES: Record<DetailMode, string> = { compact: '简洁', standard: '标准', detailed: '详细', verbose: '完全展开' };
type Status = ReturnType<typeof entryStatus>;
const LABELS: Record<Status, string> = { running: '正在执行', completed: '已完成', failed: '执行失败', interrupted: '已中断', unknown: '执行记录' };

const failedItem = (item: ViewItem) => item.event.type === 'error' || item.event.payload.status === 'failed'
  || typeof item.event.payload.exitCode === 'number' && item.event.payload.exitCode !== 0;

export function TurnView({ entry, session, mode, render, onMoreItems }: {
  entry: EntryView; session?: Session; mode: DetailMode;
  render(item: ViewItem, expanded: boolean): React.ReactNode;
  onMoreItems?(key: string, before: number): void;
}) {
  const status = entryStatus(entry, session), expanded = mode === 'verbose';
  const segments = [...new Set(entry.items.map(i => i.segment))].map(s => entry.items.filter(i => i.segment === s));
  if (entry.kind === 'notice') return <section className="execution-turn">{entry.items.map(item =>
    <React.Fragment key={item.itemId}>{render(item, expanded)}</React.Fragment>)}</section>;
  if (!segments.length) return status === 'unknown' ? null
    : <section className="execution-turn"><div className="turn-caption">{LABELS[status]}</div></section>;
  return <>{segments.map((items, index) => <Segment key={items[0]!.itemId} entry={entry} items={items} last={index === segments.length - 1}
    status={index === segments.length - 1 ? status : 'unknown'} mode={mode} render={render}
    more={index === 0 && entry.itemsBefore !== null && onMoreItems ? () => onMoreItems(entry.key, entry.itemsBefore!) : undefined} />)}</>;
}

function Segment({ entry, items, last, status, mode, render, more }: {
  entry: EntryView; items: ViewItem[]; last: boolean; status: Status; mode: DetailMode;
  render(item: ViewItem, expanded: boolean): React.ReactNode; more?: () => void;
}) {
  const prompts = items.filter(i => i.role === 'prompt'), process = items.filter(i => i.role === 'process'), final = items.find(i => i.role === 'final');
  const [chosenOpen, setChosenOpen] = useState<boolean>();
  const attention = status === 'failed' || status === 'interrupted' || process.some(failedItem);
  const expanded = mode === 'verbose';
  const open = expanded || (chosenOpen ?? (attention || status === 'running' || status === 'unknown' && last || mode === 'detailed'));
  const tools = process.filter(i => i.kind === 'tool').length;
  const label = status === 'running' && entry.lastPhase === 'thinking' ? '正在思考' : LABELS[status];
  const duration = !last || entry.durationMs === undefined ? '' : ` · 用时 ${entry.durationMs < 1000 ? '<1 秒' : `${Math.round(entry.durationMs / 1000)} 秒`}`;
  const after = last && entry.eventsAfterTerminal > 0 && status !== 'running' ? ' · 之后仍有活动' : '';
  const omitted = more ? entry.itemCount - entry.items.length : 0;
  return <section className={`execution-turn ${attention ? 'needs-attention' : ''}`}>
    {prompts.map(item => <React.Fragment key={item.itemId}>{render(item, expanded)}</React.Fragment>)}
    {process.length > 0 || more ? <div className="turn-work">
      <button type="button" className="turn-summary" aria-expanded={open} onClick={() => setChosenOpen(!open)} disabled={expanded}>
        <span aria-hidden="true">{open ? '⌄' : '›'}</span><strong>{label}</strong>
        <span>{tools ? `${tools} 次工具调用` : '执行过程'}{duration}{after}{last && entry.partial ? ' · 部分记录' : ''}</span>
      </button>
      {open && <div className={`turn-steps mode-${mode}`}>
        {more && omitted > 0 && <button type="button" className="load-more" onClick={more}>↑ 显示更早的 {omitted} 步</button>}
        {process.map((item, i) => <div className="turn-step" key={item.itemId}>
          {mode !== 'compact' && <span className="step-number" aria-label={`步骤 ${i + 1}`}>{i + 1}</span>}
          <div>{render(item, expanded)}</div>
        </div>)}</div>}
    </div> : status !== 'unknown' && <div className="turn-caption">{label}{duration}{after}</div>}
    {final && render(final, expanded)}
  </section>;
}
