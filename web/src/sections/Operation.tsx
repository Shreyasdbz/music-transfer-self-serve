import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Button, Card, Dropdown } from "../components/index.js";
import { catalog, gate, prefill, providers, run, startOperation, setToast } from "../store.js";
import type { TargetInput } from "../api/client.js";

type Side = "source" | "destination";
interface Disambig {
  side: Side;
  candidates: { id: string; name: string }[];
}

function buildTarget(key: string, createName: string): TargetInput | null {
  if (key === "liked" || key === "favorites") return { kind: key };
  if (key.startsWith("playlist:")) return { kind: "playlist", id: key.slice("playlist:".length) };
  if (key === "create") return createName.trim() ? { query: createName.trim() } : null;
  return null;
}

export function Operation(): JSX.Element {
  const [srcProvider, setSrcProvider] = createSignal("");
  const [srcTarget, setSrcTarget] = createSignal("");
  const [dstProvider, setDstProvider] = createSignal("");
  const [dstTarget, setDstTarget] = createSignal("");
  const [createName, setCreateName] = createSignal("");
  const [disambig, setDisambig] = createSignal<Disambig | undefined>();

  // Default provider selections once providers load.
  createEffect(() => {
    const list = providers();
    if (list.length && !srcProvider()) setSrcProvider(list[0]!.id);
    if (list.length > 1 && !dstProvider()) setDstProvider(list.find((p) => p.id !== list[0]!.id)!.id);
  });

  // Catalog "Transfer" pre-fills the source side.
  createEffect(() => {
    const pf = prefill();
    if (!pf) return;
    setSrcProvider(pf.provider);
    setSrcTarget(targetKey(pf.target));
    // Keep destination distinct from the new source.
    if (dstProvider() === pf.provider) {
      const other = providers().find((p) => p.id !== pf.provider);
      if (other) setDstProvider(other.id);
    }
  });

  const providerOptions = (exclude?: string) =>
    providers()
      .filter((p) => p.id !== exclude)
      .map((p) => ({ value: p.id, label: p.displayName }));

  const targetOptions = (providerId: string, isDest: boolean) => {
    const p = providers().find((x) => x.id === providerId);
    const opts: { value: string; label: string }[] = [];
    if (p?.likedKind === "liked") opts.push({ value: "liked", label: "★ Liked songs" });
    if (p?.likedKind === "favorites") opts.push({ value: "favorites", label: "★ Favorite songs" });
    for (const row of (catalog()?.rows ?? []).filter((r) => r.platform === providerId && r.kind === "playlist")) {
      opts.push({ value: `playlist:${row.external_id}`, label: row.name ?? row.external_id });
    }
    if (isDest) opts.push({ value: "create", label: "＋ Create new…" });
    return opts;
  };

  const canStart = createMemo(() => {
    if (!gate().open || run.running) return false;
    if (!srcProvider() || !dstProvider() || srcProvider() === dstProvider()) return false;
    const src = buildTarget(srcTarget(), "");
    const dst = buildTarget(dstTarget(), createName());
    return !!src && !!dst;
  });

  async function start(forceCreate = false): Promise<void> {
    const src = buildTarget(srcTarget(), "");
    let dst = buildTarget(dstTarget(), createName());
    if (forceCreate && dstTarget() === "create") dst = { query: createName().trim(), forceCreate: true };
    if (!src || !dst) {
      setToast("Choose a source and a destination.");
      return;
    }
    setDisambig(undefined);
    const res = await startOperation({
      source: srcProvider(),
      destination: dstProvider(),
      sourceTarget: src,
      destinationTarget: dst,
    });
    if (res.ok) return;
    if (res.status === 422) {
      const b = res.body as { side?: Side; error?: string; candidates?: { id: string; name: string }[] };
      if (b.error === "ambiguous_name" && b.candidates) setDisambig({ side: b.side ?? "source", candidates: b.candidates });
      else setToast(`Could not resolve ${b.side ?? "target"}: ${b.error}`);
    } else if (res.status === 412) setToast("Run the permissions check first.");
    else if (res.status === 409) setToast("An operation is already running.");
    else setToast(`Could not start the transfer (${res.status}).`);
  }

  function pickCandidate(id: string): void {
    const d = disambig();
    if (!d) return;
    if (d.side === "source") setSrcTarget(`playlist:${id}`);
    else setDstTarget(`playlist:${id}`);
    setDisambig(undefined);
    void start();
  }

  return (
    <section class="section" id="operation" aria-labelledby="op-h">
      <h2 id="op-h" class="section-title t-subheading">
        Operation
      </h2>
      <p class="section-sub t-caption">Pick where to transfer from and to, then start. Additive only — nothing is removed.</p>
      <Card>
        <div class="op-grid">
          <label class="t-note" for="src-provider">
            Transfer from
          </label>
          <Dropdown
            aria-label="Source service"
            value={srcProvider()}
            options={providerOptions()}
            onChange={(v) => {
              setSrcProvider(v);
              setSrcTarget("");
            }}
          />
          <Dropdown
            aria-label="Source playlist"
            value={srcTarget()}
            options={[{ value: "", label: "Choose…" }, ...targetOptions(srcProvider(), false)]}
            onChange={setSrcTarget}
          />

          <label class="t-note" for="dst-provider">
            Transfer to
          </label>
          <Dropdown
            aria-label="Destination service"
            value={dstProvider()}
            options={providerOptions(srcProvider())}
            onChange={(v) => {
              setDstProvider(v);
              setDstTarget("");
            }}
          />
          <Show
            when={dstTarget() !== "create"}
            fallback={
              <input
                class="t-note"
                placeholder="New playlist name"
                value={createName()}
                onInput={(e) => setCreateName(e.currentTarget.value)}
                aria-label="New playlist name"
              />
            }
          >
            <Dropdown
              aria-label="Destination playlist"
              value={dstTarget()}
              options={[{ value: "", label: "Choose…" }, ...targetOptions(dstProvider(), true)]}
              onChange={setDstTarget}
            />
          </Show>
        </div>

        <div style={{ "margin-top": "var(--space-lg)" }}>
          <Button variant="tier2" class="btn-block" disabled={!canStart()} onClick={() => void start()}>
            {run.running ? "Transferring…" : "Start transfer"}
          </Button>
          <Show when={!gate().open}>
            <p class="t-subtle" style={{ color: "var(--color-text-muted)", "margin-top": "var(--space-sm)" }}>
              Run the permissions check above to enable transfers.
            </p>
          </Show>
        </div>
      </Card>

      <Show when={disambig()}>
        {(d) => (
          <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Choose a playlist">
            <div class="modal">
              <h3 class="t-headline" style={{ margin: 0 }}>
                Multiple {d().side} playlists match
              </h3>
              <p class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                Pick the one you meant{d().side === "destination" ? ", or create a new one." : "."}
              </p>
              <ul class="modal-list">
                <For each={d().candidates}>
                  {(c) => (
                    <li>
                      <Button class="btn-block" onClick={() => pickCandidate(c.id)}>
                        {c.name}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
              <div class="cluster">
                <Show when={d().side === "destination"}>
                  <Button variant="tier2" onClick={() => void start(true)}>
                    Create new instead
                  </Button>
                </Show>
                <Button onClick={() => setDisambig(undefined)}>Cancel</Button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

function targetKey(t: TargetInput): string {
  if (t.kind === "liked" || t.kind === "favorites") return t.kind;
  if (t.kind === "playlist" && t.id) return `playlist:${t.id}`;
  return "";
}
