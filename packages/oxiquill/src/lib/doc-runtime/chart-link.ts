import { chartAxisType } from './chart-axes.js';
import type { ChartAxisType, ChartLink, ChartSpec } from './types.js';

export type ChartRange = readonly [number, number];
export interface ChartLinkIdentity {
  link: ChartLink;
  xType: ChartAxisType;
  unit?: string;
}
export interface ChartLinkMember extends ChartLinkIdentity {
  domain?: ChartRange;
  viewport: (range: ChartRange | undefined) => void;
  cursor: (value: number | undefined) => void;
  status: (disjoint: boolean) => void;
}

export function chartLinkIdentity(spec: ChartSpec): ChartLinkIdentity | undefined {
  return 'link' in spec && spec.link
    ? { link: spec.link, xType: chartAxisType(spec, 'x'), unit: spec.style?.xFormat?.unit }
    : undefined;
}

export function chartLinkConflict(member: ChartLinkIdentity, peers: readonly ChartLinkIdentity[]): string | undefined {
  const group = peers.filter((peer) => peer.link.group === member.link.group);
  if (group.some((peer) => peer.xType !== member.xType))
    return `Chart link group "${member.link.group}" requires the same xType as its first registered member.`;
  if (group.some((peer) => peer.unit !== undefined && member.unit !== undefined && peer.unit !== member.unit))
    return `Chart link group "${member.link.group}" has conflicting explicit xFormat.unit values.`;
  return undefined;
}

export function intersectChartRange(range: ChartRange, domain: ChartRange | undefined): ChartRange | undefined {
  if (!domain) return undefined;
  const start = Math.max(range[0], domain[0]);
  const end = Math.min(range[1], domain[1]);
  return start <= end ? [start, end] : undefined;
}

/** Stateful boundary only: calculations and compatibility rules above remain pure. */
export function createChartLinkCoordinator() {
  const members = new Map<object, ChartLinkMember>();
  const ranges = new Map<string, ChartRange>();
  const applying = new Set<object>();

  function deliver(identity: object, apply: () => void) {
    applying.add(identity);
    try {
      apply();
    } finally {
      applying.delete(identity);
    }
  }

  function receive(member: ChartLinkMember, range: ChartRange | undefined) {
    const intersection = range && intersectChartRange(range, member.domain);
    member.status(range !== undefined && intersection === undefined);
    if (!range || intersection) member.viewport(intersection);
  }

  function unregister(identity: object) {
    const member = members.get(identity);
    members.delete(identity);
    if (member && !Array.from(members.values()).some((peer) => peer.link.group === member.link.group))
      ranges.delete(member.link.group);
  }

  return {
    register(identity: object, member: ChartLinkMember) {
      const peers = Array.from(members.entries()).flatMap(([key, peer]) => (key === identity ? [] : [peer]));
      const conflict = chartLinkConflict(member, peers);
      if (conflict) throw new Error(conflict);
      const previous = members.get(identity);
      const joining = previous?.link.group !== member.link.group;
      if (joining) unregister(identity);
      members.set(identity, member);
      const range = ranges.get(member.link.group);
      if (joining && range && member.link.zoom !== false) deliver(identity, () => receive(member, range));
    },
    unregister,
    viewport(identity: object, range?: ChartRange) {
      const source = members.get(identity);
      if (!source || source.link.zoom === false || applying.has(identity)) return;
      if (range) ranges.set(source.link.group, range);
      else ranges.delete(source.link.group);
      source.status(false);
      for (const [key, peer] of members) {
        if (key !== identity && peer.link.group === source.link.group && peer.link.zoom !== false)
          deliver(key, () => receive(peer, range));
      }
    },
    cursor(identity: object, value?: number) {
      const source = members.get(identity);
      if (!source || source.link.cursor === false || applying.has(identity)) return;
      for (const [key, peer] of members) {
        if (key !== identity && peer.link.group === source.link.group && peer.link.cursor !== false)
          deliver(key, () => peer.cursor(value));
      }
    },
    clear() {
      members.clear();
      ranges.clear();
      applying.clear();
    },
    get size() {
      return members.size;
    }
  };
}

export type ChartLinkCoordinator = ReturnType<typeof createChartLinkCoordinator>;

// The page owner releases this entry and its navigation listener with its last chart.
const pages = new WeakMap<Document, { coordinator: ChartLinkCoordinator; release: () => void; users: number }>();

export function acquirePageChartLinks(page: Document) {
  let entry = pages.get(page);
  if (!entry) {
    const coordinator = createChartLinkCoordinator();
    const release = () => {
      coordinator.clear();
      page.removeEventListener('astro:before-swap', release);
      pages.delete(page);
    };
    entry = { coordinator, release, users: 0 };
    pages.set(page, entry);
    page.addEventListener('astro:before-swap', release);
  }
  const owned = entry;
  owned.users += 1;
  let released = false;
  return {
    coordinator: owned.coordinator,
    release() {
      if (released) return;
      released = true;
      owned.users -= 1;
      // An old page's delayed cleanup must never release its replacement.
      if (owned.users === 0 && pages.get(page) === owned) owned.release();
    }
  };
}
