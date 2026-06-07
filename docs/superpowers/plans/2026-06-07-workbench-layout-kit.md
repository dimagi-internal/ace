# WorkbenchLayout Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a generic, reusable three-pane `WorkbenchLayout` kit (left rail · center · right rail — each collapsible, push or overlay/slide mode) in ace-web, and prove it by re-homing the existing `OppWorkbenchPage` onto it with no functional regression.

**Architecture:** A small dependency-clean module under `frontend/src/components/workbench/` — a generalized collapse hook (`usePaneCollapsed`), a single collapsible rail (`WorkbenchRail`), and the composing layout (`WorkbenchLayout`). Pure presentational, props-in, no ace-web store/domain coupling, so a later cross-repo extraction is trivial. `OppWorkbenchPage` becomes the first consumer: left rail = lifecycle list, center = step detail, right rail = chat.

**Tech Stack:** React 18 + TypeScript, Vite, TailwindCSS (shadcn design tokens: `bg-background`/`bg-card`/`border-border`/`text-muted-foreground`), `lucide-react` icons, Vitest + jsdom + `@testing-library/react`.

**TARGET REPO:** `ace-web` (`/Users/acedimagi/emdash/repositories/ace-web`). This plan doc lives in the `ace` plugin repo as the coordination home; **execute it in an ace-web worktree off `main`** (`git worktree add -b feat/workbench-layout-kit <path> origin/main`). All file paths below are relative to the ace-web repo root.

**Commands:** from `frontend/`: tests `npx vitest run`, type-check `npx tsc -b`, dev `npm run dev`.

---

## File Structure

- Create: `frontend/src/components/workbench/usePaneCollapsed.ts` — localStorage-persisted collapse state, keyed per pane.
- Create: `frontend/src/components/workbench/WorkbenchRail.tsx` — one collapsible side rail (left or right; push or overlay mode).
- Create: `frontend/src/components/workbench/WorkbenchLayout.tsx` — composes header + optional toolbar + left/center/right.
- Create: `frontend/src/components/workbench/index.ts` — barrel export (the kit's public surface).
- Create: `frontend/src/components/workbench/README.md` — the three-pane contract (so future UIs + an eventual canopy-web migration conform).
- Create: `frontend/src/components/workbench/__tests__/usePaneCollapsed.test.tsx`
- Create: `frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx`
- Create: `frontend/src/components/workbench/__tests__/WorkbenchLayout.test.tsx`
- Modify: `frontend/src/pages/OppWorkbenchPage.tsx` (replace the inline 3-pane markup in the `view === "workbench"` block with `<WorkbenchLayout>`; swap `useChatPaneCollapsed` for `usePaneCollapsed`).
- Reference (do not modify): `frontend/src/hooks/useChatPaneCollapsed.ts` (the pattern being generalized — leave it; OppWorkbenchPage stops importing it).

**Intentional UX change (not a regression):** today `OppWorkbenchPage`'s lifecycle list grows (`flex-1`) when the chat is open and the detail pane is fixed; in the canonical kit the **center detail always grows** and both side rails are fixed-width + collapsible. This is the deliberate move to the left-rail/center/right-rail model (the target design), not an accidental behavior change. Call it out in the refactor commit.

---

## Task 1: `usePaneCollapsed` hook

Generalizes `useChatPaneCollapsed` to any pane via a storage key.

**Files:**
- Create: `frontend/src/components/workbench/usePaneCollapsed.ts`
- Test: `frontend/src/components/workbench/__tests__/usePaneCollapsed.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/workbench/__tests__/usePaneCollapsed.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePaneCollapsed } from "../usePaneCollapsed";

describe("usePaneCollapsed", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to false and toggles", () => {
    const { result } = renderHook(() => usePaneCollapsed("test.key"));
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
  });

  it("honors the defaultCollapsed argument when storage is empty", () => {
    const { result } = renderHook(() => usePaneCollapsed("test.key2", true));
    expect(result.current.collapsed).toBe(true);
  });

  it("persists to localStorage under the given key", () => {
    const { result } = renderHook(() => usePaneCollapsed("test.persist"));
    act(() => result.current.setCollapsed(true));
    expect(window.localStorage.getItem("test.persist")).toBe("1");
  });

  it("reads an existing stored value over the default", () => {
    window.localStorage.setItem("test.read", "1");
    const { result } = renderHook(() => usePaneCollapsed("test.read", false));
    expect(result.current.collapsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/workbench/__tests__/usePaneCollapsed.test.tsx`
Expected: FAIL — `Cannot find module '../usePaneCollapsed'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/workbench/usePaneCollapsed.ts
import { useCallback, useEffect, useState } from "react";

/**
 * localStorage-persisted collapse state for a workbench pane, keyed per
 * pane so multiple rails on one page don't collide. Generalized from
 * hooks/useChatPaneCollapsed.ts. Falls back to per-tab state when storage
 * is unavailable (private mode).
 */
export function usePaneCollapsed(
  storageKey: string,
  defaultCollapsed = false,
): { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void } {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultCollapsed;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return defaultCollapsed;
      return raw === "1";
    } catch {
      return defaultCollapsed;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, collapsed ? "1" : "0");
    } catch {
      // storage disabled — preference is per-tab only
    }
  }, [storageKey, collapsed]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  return { collapsed, toggle, setCollapsed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/workbench/__tests__/usePaneCollapsed.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workbench/usePaneCollapsed.ts frontend/src/components/workbench/__tests__/usePaneCollapsed.test.tsx
git commit -m "feat(workbench): usePaneCollapsed — generalized per-key collapse hook"
```

---

## Task 2: `WorkbenchRail` — collapsible side rail (push mode)

One rail that renders its content (expanded) or a thin icon strip (collapsed), for either side. Width animates (the "slide").

**Files:**
- Create: `frontend/src/components/workbench/WorkbenchRail.tsx`
- Test: `frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkbenchRail } from "../WorkbenchRail";

describe("WorkbenchRail", () => {
  it("renders title + content when expanded", () => {
    render(
      <WorkbenchRail side="right" title="Chat" collapsed={false} onToggle={() => {}}>
        <div>pane body</div>
      </WorkbenchRail>,
    );
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("pane body")).toBeInTheDocument();
  });

  it("hides content and shows the expand affordance when collapsed", () => {
    render(
      <WorkbenchRail side="right" title="Chat" collapsed onToggle={() => {}}>
        <div>pane body</div>
      </WorkbenchRail>,
    );
    expect(screen.queryByText("pane body")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });

  it("calls onToggle when the collapse button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <WorkbenchRail side="right" title="Chat" collapsed={false} onToggle={onToggle}>
        <div>pane body</div>
      </WorkbenchRail>,
    );
    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchRail.test.tsx`
Expected: FAIL — `Cannot find module '../WorkbenchRail'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/workbench/WorkbenchRail.tsx
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type RailSide = "left" | "right";
export type RailMode = "push" | "overlay";

export interface WorkbenchRailProps {
  children: ReactNode;
  /** Which edge the rail sits on (controls border + chevron direction). */
  side: RailSide;
  /** Short label shown in the expanded rail's header + aria labels. */
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Expanded width in px. Default 400. */
  expandedWidth?: number;
  /** Width of the collapsed icon strip in px. Default 32. */
  collapsedWidth?: number;
  /** "push" (default) reflows the center; "overlay" floats over it (Task 4). */
  mode?: RailMode;
}

// Chevron that points "outward" to expand and "inward" to collapse,
// mirrored per side. Right rail: collapse = ChevronRight, expand = ChevronLeft.
function railChevron(side: RailSide, action: "collapse" | "expand") {
  const pointsRight =
    (side === "right" && action === "collapse") ||
    (side === "left" && action === "expand");
  return pointsRight ? ChevronRight : ChevronLeft;
}

export function WorkbenchRail({
  children,
  side,
  title,
  collapsed,
  onToggle,
  expandedWidth = 400,
  collapsedWidth = 32,
}: WorkbenchRailProps) {
  const borderClass = side === "left" ? "border-r" : "border-l";

  if (collapsed) {
    const Expand = railChevron(side, "expand");
    return (
      <aside
        className={`flex shrink-0 flex-col items-center ${borderClass} border-border bg-card transition-[width] duration-150`}
        style={{ width: collapsedWidth }}
      >
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Show ${title} pane`}
          aria-label={`Show ${title} pane`}
          aria-expanded="false"
        >
          <Expand className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  const Collapse = railChevron(side, "collapse");
  return (
    <aside
      className={`flex shrink-0 flex-col ${borderClass} border-border bg-card transition-[width] duration-150`}
      style={{ width: expandedWidth }}
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Hide ${title} pane`}
          aria-label={`Hide ${title} pane`}
          aria-expanded="true"
        >
          <Collapse className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchRail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workbench/WorkbenchRail.tsx frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx
git commit -m "feat(workbench): WorkbenchRail — collapsible left/right rail (push mode)"
```

---

## Task 3: `WorkbenchLayout` — compose the three panes

**Files:**
- Create: `frontend/src/components/workbench/WorkbenchLayout.tsx`
- Test: `frontend/src/components/workbench/__tests__/WorkbenchLayout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/workbench/__tests__/WorkbenchLayout.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkbenchLayout } from "../WorkbenchLayout";

describe("WorkbenchLayout", () => {
  it("renders header, toolbar and center", () => {
    render(
      <WorkbenchLayout
        header={<div>HEADER</div>}
        toolbar={<div>TABS</div>}
        center={<div>CENTER</div>}
      />,
    );
    expect(screen.getByText("HEADER")).toBeInTheDocument();
    expect(screen.getByText("TABS")).toBeInTheDocument();
    expect(screen.getByText("CENTER")).toBeInTheDocument();
  });

  it("renders left and right rails when provided", () => {
    render(
      <WorkbenchLayout
        center={<div>CENTER</div>}
        left={{ title: "Nav", collapsed: false, onToggle: () => {}, content: <div>LEFT</div> }}
        right={{ title: "Inspector", collapsed: false, onToggle: () => {}, content: <div>RIGHT</div> }}
      />,
    );
    expect(screen.getByText("LEFT")).toBeInTheDocument();
    expect(screen.getByText("RIGHT")).toBeInTheDocument();
    expect(screen.getByText("Nav")).toBeInTheDocument();
    expect(screen.getByText("Inspector")).toBeInTheDocument();
  });

  it("omits rails that are not provided", () => {
    render(<WorkbenchLayout center={<div>CENTER</div>} />);
    expect(screen.queryByText("LEFT")).not.toBeInTheDocument();
    expect(screen.queryByText("RIGHT")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchLayout.test.tsx`
Expected: FAIL — `Cannot find module '../WorkbenchLayout'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/workbench/WorkbenchLayout.tsx
import type { ReactNode } from "react";
import { WorkbenchRail, type RailMode } from "./WorkbenchRail";

export interface WorkbenchRailConfig {
  content: ReactNode;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  expandedWidth?: number;
  collapsedWidth?: number;
  mode?: RailMode;
}

export interface WorkbenchLayoutProps {
  /** Sticky header slot (e.g. WorkbenchHeader with the run picker). */
  header?: ReactNode;
  /** Optional toolbar under the header (e.g. ViewSwitcher tabs). */
  toolbar?: ReactNode;
  /** Left rail — the entity navigator (lifecycle / narrative+runs). */
  left?: WorkbenchRailConfig;
  /** Center detail canvas. Always grows to fill remaining width. */
  center: ReactNode;
  /** Right rail — the inspector / chat. */
  right?: WorkbenchRailConfig;
  className?: string;
}

/**
 * Generic three-pane workbench shell: [left rail | center | right rail].
 * Each rail is independently collapsible (push mode here; overlay in
 * WorkbenchRail Task 4). Center always flex-grows. Pure presentational —
 * pass collapse state in via usePaneCollapsed. See README.md for the
 * three-pane contract.
 */
export function WorkbenchLayout({
  header,
  toolbar,
  left,
  center,
  right,
  className,
}: WorkbenchLayoutProps) {
  return (
    <div className={`flex h-full flex-col bg-background text-foreground ${className ?? ""}`}>
      {header}
      {toolbar}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {left ? (
          <WorkbenchRail
            side="left"
            title={left.title}
            collapsed={left.collapsed}
            onToggle={left.onToggle}
            expandedWidth={left.expandedWidth}
            collapsedWidth={left.collapsedWidth}
            mode={left.mode}
          >
            {left.content}
          </WorkbenchRail>
        ) : null}
        <main className="min-h-0 flex-1 overflow-y-auto">{center}</main>
        {right ? (
          <WorkbenchRail
            side="right"
            title={right.title}
            collapsed={right.collapsed}
            onToggle={right.onToggle}
            expandedWidth={right.expandedWidth}
            collapsedWidth={right.collapsedWidth}
            mode={right.mode}
          >
            {right.content}
          </WorkbenchRail>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchLayout.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workbench/WorkbenchLayout.tsx frontend/src/components/workbench/__tests__/WorkbenchLayout.test.tsx
git commit -m "feat(workbench): WorkbenchLayout — three-pane shell composing rails + center"
```

---

## Task 4: Overlay / slide-over mode for `WorkbenchRail`

Adds the configurable "slide-in/slide-out" mode: instead of reflowing the center, the rail floats over it and slides via transform. Selected per-rail with `mode="overlay"`.

**Files:**
- Modify: `frontend/src/components/workbench/WorkbenchRail.tsx`
- Test: `frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `WorkbenchRail.test.tsx`:

```tsx
describe("WorkbenchRail overlay mode", () => {
  it("keeps content mounted but translated off-canvas when collapsed", () => {
    render(
      <WorkbenchRail
        side="right" title="Inspector" mode="overlay" collapsed onToggle={() => {}}
      >
        <div>overlay body</div>
      </WorkbenchRail>,
    );
    // In overlay mode the body stays mounted (so its state survives a
    // slide-out) — it is hidden via transform/aria, not unmounted.
    const region = screen.getByRole("complementary", { hidden: true });
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("overlay body")).toBeInTheDocument();
  });

  it("is visible (aria-hidden false) when expanded in overlay mode", () => {
    render(
      <WorkbenchRail
        side="right" title="Inspector" mode="overlay" collapsed={false} onToggle={() => {}}
      >
        <div>overlay body</div>
      </WorkbenchRail>,
    );
    expect(screen.getByRole("complementary")).toHaveAttribute("aria-hidden", "false");
  });
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchRail.test.tsx`
Expected: FAIL on the two overlay cases (push mode unmounts/has no `complementary` role with aria-hidden).

- [ ] **Step 3: Implement overlay mode**

Replace the body of `WorkbenchRail` so it branches on `mode`. Keep the existing push branch; add an overlay branch BEFORE it:

```tsx
// inside WorkbenchRail(), after destructuring props and computing borderClass:
  if (mode === "overlay") {
    const Collapse = railChevron(side, "collapse");
    const Expand = railChevron(side, "expand");
    const edge = side === "left" ? "left-0" : "right-0";
    const hiddenTransform =
      side === "left" ? "translateX(-100%)" : "translateX(100%)";
    return (
      <>
        {/* Persistent edge trigger so a fully slid-out rail can be reopened. */}
        {collapsed ? (
          <aside
            className={`flex shrink-0 flex-col items-center ${borderClass} border-border bg-card`}
            style={{ width: collapsedWidth }}
          >
            <button
              type="button"
              onClick={onToggle}
              className="mt-2 flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
              title={`Show ${title} pane`}
              aria-label={`Show ${title} pane`}
            >
              <Expand className="h-4 w-4" />
            </button>
          </aside>
        ) : null}
        <aside
          role="complementary"
          aria-hidden={collapsed ? "true" : "false"}
          className={`absolute top-0 ${edge} z-20 flex h-full flex-col ${borderClass} border-border bg-card shadow-lg transition-transform duration-150`}
          style={{
            width: expandedWidth,
            transform: collapsed ? hiddenTransform : "translateX(0)",
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-2 py-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {title}
            </span>
            <button
              type="button"
              onClick={onToggle}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={`Hide ${title} pane`}
              aria-label={`Hide ${title} pane`}
            >
              <Collapse className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </aside>
      </>
    );
  }
```

Note: overlay positioning is relative to the nearest positioned ancestor. In `WorkbenchLayout`, add `relative` to the panes row so the overlay anchors correctly — change `<div className="flex min-h-0 flex-1 overflow-hidden">` to `<div className="relative flex min-h-0 flex-1 overflow-hidden">` in `WorkbenchLayout.tsx`.

- [ ] **Step 4: Run to verify all WorkbenchRail tests pass**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchRail.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workbench/WorkbenchRail.tsx frontend/src/components/workbench/WorkbenchLayout.tsx frontend/src/components/workbench/__tests__/WorkbenchRail.test.tsx
git commit -m "feat(workbench): configurable overlay/slide-over rail mode"
```

---

## Task 5: Barrel export + contract README

**Files:**
- Create: `frontend/src/components/workbench/index.ts`
- Create: `frontend/src/components/workbench/README.md`

- [ ] **Step 1: Write the barrel**

```ts
// frontend/src/components/workbench/index.ts
export { WorkbenchLayout } from "./WorkbenchLayout";
export type { WorkbenchLayoutProps, WorkbenchRailConfig } from "./WorkbenchLayout";
export { WorkbenchRail } from "./WorkbenchRail";
export type { WorkbenchRailProps, RailSide, RailMode } from "./WorkbenchRail";
export { usePaneCollapsed } from "./usePaneCollapsed";
```

- [ ] **Step 2: Write the contract README**

```md
# WorkbenchLayout kit

Generic three-pane workbench shell: **[ left rail | center | right rail ]**.
Each rail is independently collapsible (`push` reflows the center; `overlay`
slides over it). Center always grows. Pure presentational — pass collapse
state in via `usePaneCollapsed(storageKey, default)`.

## Contract (future UIs + an eventual canopy-web migration conform to this)
- **Left rail** = the entity navigator: the list you select from (lifecycle
  steps / narrative beats + runs). Collapsible.
- **Center** = the detail canvas for the selected entity. Always flex-grows.
- **Right rail** = the inspector / chat / edit surface for the selection.
- **Header** slot holds the run picker; **toolbar** slot holds view tabs.

## Usage
```tsx
const left = usePaneCollapsed("ace.video.navCollapsed");
const right = usePaneCollapsed("ace.video.inspectorCollapsed");
<WorkbenchLayout
  header={<MyHeader />}
  toolbar={<MyTabs />}
  left={{ title: "Narrative", collapsed: left.collapsed, onToggle: left.toggle, content: <NavRail/> }}
  center={<DetailPane/>}
  right={{ title: "Inspector", collapsed: right.collapsed, onToggle: right.toggle, content: <Inspector/>, mode: "overlay" }}
/>
```

## Boundary
No app/store/domain imports — props in only — so this is cheap to extract
into a shared cross-repo package when a second app (canopy-web) adopts it.
```

- [ ] **Step 3: Run the full kit test suite + type-check**

Run: `npx vitest run src/components/workbench/` then `npx tsc -b`
Expected: all kit tests PASS; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/workbench/index.ts frontend/src/components/workbench/README.md
git commit -m "docs(workbench): barrel export + three-pane contract README"
```

---

## Task 6: Re-home `OppWorkbenchPage` onto `WorkbenchLayout`

Prove the kit on the real, battle-tested consumer. Map: **left rail = `SkillList`**, **center = `StepDetailPane`/EmptyState**, **right rail = `WorkbenchChatPane`**.

**Files:**
- Modify: `frontend/src/pages/OppWorkbenchPage.tsx`

- [ ] **Step 1: Capture the baseline**

Run: `npx vitest run` (note the pass count) and `npx tsc -b` (note clean). Then `npm run dev`, open an opp workbench, and confirm current behavior (3 panes, chat collapse toggles). This is the regression reference.

- [ ] **Step 2: Swap the collapse hook**

In `OppWorkbenchPage.tsx`, replace the import + call:

```tsx
// remove:
import { useChatPaneCollapsed } from "../hooks/useChatPaneCollapsed";
// add:
import { usePaneCollapsed } from "../components/workbench";

// remove:
//   const { collapsed: chatCollapsed, toggle: toggleChatCollapsed } = useChatPaneCollapsed();
// add (preserve the existing storage key so the user's saved preference carries over):
const { collapsed: chatCollapsed, toggle: toggleChatCollapsed } = usePaneCollapsed(
  "ace.workbench.chatPaneCollapsed",
);
const { collapsed: navCollapsed, toggle: toggleNavCollapsed } = usePaneCollapsed(
  "ace.workbench.navPaneCollapsed",
);
```

- [ ] **Step 3: Replace the `view === "workbench"` markup**

Replace the entire `{view === "workbench" && ( … )}` block (the `<>` containing the inline `flex flex-1` panes + the `<main>/<section>/<aside>` markup) with:

```tsx
{view === "workbench" && (
  <WorkbenchLayout
    left={{
      title: "Lifecycle",
      collapsed: navCollapsed,
      onToggle: toggleNavCollapsed,
      expandedWidth: 440,
      content: (
        <SkillList
          steps={snapshot.current_run.steps}
          priorRunSteps={[]}
          phases={snapshot.phases}
          selectedSkill={selectedSkill}
          onSelect={setSelectedSkill}
          costRollup={costRollup}
        />
      ),
    }}
    center={
      selectedStep ? (
        <StepDetailPane
          workspaceSlug={workspaceSlug ?? ""}
          slug={slug}
          runId={snapshot.current_run.run_id}
          skill={selectedStep.skill_name}
          skillDisplayName={selectedStep.display_name}
        />
      ) : (
        <EmptyState
          title="Select a step"
          description="Click a row in the lifecycle to see its details."
        />
      )
    }
    right={{
      title: "Chat",
      collapsed: chatCollapsed,
      onToggle: toggleChatCollapsed,
      expandedWidth: 400,
      content: selectedStep ? (
        <WorkbenchChatPane
          slug={slug}
          runId={snapshot.current_run.run_id}
          skill={selectedStep.skill_name}
          skillDisplayName={selectedStep.display_name}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
          Select a step in the lifecycle to see its chats
        </div>
      ),
    }}
  />
)}
```

Add the import at the top: `import { WorkbenchLayout, usePaneCollapsed } from "../components/workbench";` (and remove the now-unused `ChevronLeft, ChevronRight` import if nothing else uses it — check the file first; `grep -n "Chevron" frontend/src/pages/OppWorkbenchPage.tsx`).

Note: the outer `<div className="flex h-full flex-col …">` and `WorkbenchHeader` + `ViewSwitcher` stay OUTSIDE `WorkbenchLayout` (the page keeps its own header/tabs since other views — phase/heatmap/diff — share them). Only the workbench *view* uses `WorkbenchLayout`'s center/rails; pass `header`/`toolbar` as `undefined` here. (A later cleanup can move header+tabs into the layout's slots once all views are migrated — out of scope.)

- [ ] **Step 4: Type-check + full test suite (regression gate)**

Run: `npx tsc -b` then `npx vitest run`
Expected: tsc clean; test count = baseline from Step 1 (no test deletions, no new failures).

- [ ] **Step 5: Manual regression check**

Run `npm run dev`, open an opp workbench. Verify: left lifecycle rail (collapsible via its header chevron), center step detail grows, right chat rail collapses to the icon strip, saved chat-collapse preference still honored (`ace.workbench.chatPaneCollapsed`). Confirm phase/heatmap/diff tabs still render.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/OppWorkbenchPage.tsx
git commit -m "refactor(opps): re-home OppWorkbench onto WorkbenchLayout kit (left rail = lifecycle, center = detail, right rail = chat)"
```

---

## Self-Review checklist (run before opening the PR)

- [ ] **Spec coverage:** kit provides left/center/right (Task 3), each collapsible (Tasks 2/3) in push + overlay/slide modes (Task 4), proven by the OppWorkbench refactor (Task 6) — matches spec §5 decisions 3–4 and §7 inventory (the run-picker/`ViewSwitcher` stay as caller-provided `header`/`toolbar` slots; edit-op engine + atoms are deferred to Stage 5 per spec §7).
- [ ] **No regression:** Task 6 Step 4 asserts the full-suite count is unchanged and tsc clean; Step 5 is the manual gate.
- [ ] **Type consistency:** `WorkbenchRailConfig.content` (object form, used by `WorkbenchLayout`) vs `WorkbenchRailProps.children` (component form, used by `WorkbenchRail` directly) — intentional and consistent across Tasks 2–3.
- [ ] **Storage-key continuity:** Task 6 reuses `"ace.workbench.chatPaneCollapsed"` so existing user prefs carry over; the new left rail uses a fresh key.
- [ ] Open a PR to `jjackson/ace-web`; the new `videos`/`CI` checks must pass (note: the kit is `frontend/`, gated by the build/tsc path, not the connect-videos `videos.yml`).

---

## Next plans (not this plan)

- **Plan 2 — Narrative substrate extraction (canopy)** — lift `WhyBrief`/evidence/`Gap`/decomposition/`Verdict` + validators out of `scripts.ddd` into a neutral module + `canopy:narrative`; DDD re-points imports. Spec §6 Stage 2.
- **Stage 5 — Video review surface** on this kit (left rail = narrative + runs; center = beat/scene detail; right = inspector) — after Plan 2 + Stage 3.
