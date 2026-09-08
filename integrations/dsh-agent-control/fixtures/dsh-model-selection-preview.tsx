/** Hook-free preview stand-in. Installed TokensCowork renders DSH's real ModelSelect. */
export function ModelSelect({ locked, directory, load, select }: {
  locked: boolean
  directory: { getSnapshot(): { current: { model: string } | null; groups: Array<{ models: Array<{ id: string; name: string }> }> } }
  load(): void
  select(selection: { provider: string; model: string }): Promise<boolean>
}) {
  const state = directory.getSnapshot()
  return <select aria-label="Model for next turn" value={state.current?.model ?? ''} disabled={locked} onFocus={load}
    onChange={event => { void select({ provider: 'codex', model: event.target.value }) }}>
    {!state.current && <option value="">Select model</option>}
    {state.groups.flatMap(group => group.models).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
  </select>
}
