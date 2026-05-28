/**
 * Force-directed canvas graph wrapper.
 *
 * Renders the Mintr meeting/person bipartite graph using
 * `react-force-graph-2d` (vasturiano's MIT-licensed canvas force-graph
 * library — same author as `3d-force-graph`, `react-globe.gl`, and
 * `force-graph`). We picked this over Cytoscape / D3-directly / Sigma
 * for three reasons:
 *
 *   1. Drop-in React API — `<ForceGraph2D data={...} />` is enough to
 *      get a working force layout with pan, zoom, drag, hover, click.
 *   2. Canvas rendering (HTML5 2D context) stays performant at the
 *      ~500-1000 node scale Mintr targets without WebGL complexity.
 *   3. Custom node painting hook (`nodeCanvasObject`) lets us draw the
 *      Obsidian-style "filled circle for meetings, rounded pill for
 *      people" treatment instead of being stuck with default SVG dots.
 *
 * The component is *purely visual*. Filter state, data hydration, and
 * the right-rail detail panel all live in `views/Network.tsx`. This
 * file just paints what it's handed.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import type { NetworkGraph, NetworkNode } from '../state/networkData'

interface MeetingGraphProps {
  data: NetworkGraph
  /** Currently selected node id; rendered with a glowing ring. */
  selectedNodeId: string | null
  /** Currently hovered node id; rendered with a softer highlight. */
  hoveredNodeId: string | null
  /** Resolver for the meeting node's accent colour (uses the tag palette). */
  resolveMeetingColor: (node: NetworkNode) => string
  /** Pixel dimensions — the parent sizes us via ResizeObserver. */
  width: number
  height: number
  /** Theme — 'dark' or 'light'. Drives stroke + label colours. */
  theme: 'dark' | 'light'
  /** Substring (lowercase) used to dim nodes whose label doesn't match. */
  searchLower: string
  /** Click handler — fires for nodes; the view routes to meeting detail
   *  or filters by person. */
  onNodeClick: (node: NetworkNode) => void
  onNodeHover: (node: NetworkNode | null) => void
}

/**
 * Wrapper around ForceGraph2D. The whole thing is `React.memo`-eligible
 * via memo'd props from the caller; we don't memo here because the
 * `data` prop is rebuilt on filter change.
 */
export function MeetingGraph(props: MeetingGraphProps): JSX.Element {
  const {
    data,
    selectedNodeId,
    hoveredNodeId,
    resolveMeetingColor,
    width,
    height,
    theme,
    searchLower,
    onNodeClick,
    onNodeHover
  } = props

  const fgRef = useRef<ForceGraphMethods<NetworkNode> | undefined>(undefined)

  // Theme-aware palette. We resolve colours once per render so the
  // canvas painter doesn't recompute per-node.
  const palette = useMemo(() => {
    if (theme === 'dark') {
      return {
        labelFill: 'rgba(244, 244, 245, 0.92)',
        labelFillDim: 'rgba(161, 161, 170, 0.55)',
        nodeStroke: 'rgba(244, 244, 245, 0.18)',
        nodeStrokeHover: 'rgba(244, 244, 245, 0.55)',
        nodeStrokeSelected: '#fafafa',
        linkFill: 'rgba(244, 244, 245, 0.12)',
        linkFillHighlight: 'rgba(250, 250, 250, 0.55)',
        linkFillDashed: 'rgba(161, 161, 170, 0.30)',
        background: 'transparent'
      }
    }
    return {
      labelFill: 'rgba(24, 24, 27, 0.92)',
      labelFillDim: 'rgba(82, 82, 91, 0.55)',
      nodeStroke: 'rgba(24, 24, 27, 0.15)',
      nodeStrokeHover: 'rgba(24, 24, 27, 0.55)',
      nodeStrokeSelected: '#18181b',
      linkFill: 'rgba(24, 24, 27, 0.10)',
      linkFillHighlight: 'rgba(24, 24, 27, 0.55)',
      linkFillDashed: 'rgba(82, 82, 91, 0.35)',
      background: 'transparent'
    }
  }, [theme])

  // Index of "is this node connected to the selected/hovered one?" so
  // hover-highlight reads as a brushed neighbourhood, not just one node.
  // Recomputed only when the selection changes, NOT on every paint.
  const neighbourhood = useMemo(() => {
    const focusId = hoveredNodeId ?? selectedNodeId
    if (!focusId) return null
    const neighbours = new Set<string>([focusId])
    for (const l of data.links) {
      const s = linkEndpointId(l.source)
      const t = linkEndpointId(l.target)
      if (s === focusId) neighbours.add(t)
      if (t === focusId) neighbours.add(s)
    }
    return neighbours
  }, [data.links, hoveredNodeId, selectedNodeId])

  // d3-force tuning — gentle repulsion + medium link distance gives a
  // pleasant readable layout for tens-to-hundreds of nodes. The library
  // exposes the underlying d3 force instances via `d3Force(name)`.
  useEffect(() => {
    if (!fgRef.current) return
    const fg = fgRef.current
    // Manyboody repulsion — more negative = nodes push each other apart.
    const charge = fg.d3Force('charge') as { strength: (n: number) => unknown } | undefined
    if (charge && typeof charge.strength === 'function') {
      charge.strength(-160)
    }
    // Link distance — shorter = tighter clusters; longer = airier.
    const link = fg.d3Force('link') as { distance: (n: number) => unknown } | undefined
    if (link && typeof link.distance === 'function') {
      link.distance(48)
    }
  }, [data])

  /**
   * Custom canvas painter for nodes. We override the default 'circle'
   * with kind-specific shapes:
   *   - Meeting → filled circle, tag colour, white outline
   *   - Person  → rounded pill with the person's initials
   * Selected / hovered / neighbourhood members render with brighter
   * stroke; non-neighbours dim to ~30% opacity so the focus pops.
   */
  const paintNode = useCallback(
    (raw: NetworkNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = (raw as NetworkNode & { x?: number }).x ?? 0
      const y = (raw as NetworkNode & { y?: number }).y ?? 0
      const labelLower = raw.label.toLowerCase()
      const matchesSearch = !searchLower || labelLower.includes(searchLower)
      const inFocus =
        !neighbourhood || neighbourhood.has(raw.id) || raw.id === selectedNodeId
      const dimmed = !inFocus || !matchesSearch
      const radius = Math.max(3, raw.val) // val from networkData
      const fillColor =
        raw.kind === 'meeting' ? resolveMeetingColor(raw) : raw.color

      ctx.save()
      ctx.globalAlpha = dimmed ? 0.30 : 1

      if (raw.kind === 'meeting') {
        // Filled circle.
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, 2 * Math.PI, false)
        ctx.fillStyle = fillColor
        ctx.fill()
        ctx.lineWidth = 1 / globalScale
        ctx.strokeStyle =
          raw.id === selectedNodeId
            ? palette.nodeStrokeSelected
            : raw.id === hoveredNodeId
            ? palette.nodeStrokeHover
            : palette.nodeStroke
        ctx.stroke()
      } else {
        // Rounded pill with initials. Pill width = `radius * 2.4`, height
        // = `radius * 1.4` — wider than tall so it visually contrasts
        // with the circular meeting nodes.
        const pillW = radius * 2.4
        const pillH = radius * 1.4
        const rx = pillH / 2
        roundedRect(ctx, x - pillW / 2, y - pillH / 2, pillW, pillH, rx)
        ctx.fillStyle = fillColor
        ctx.fill()
        ctx.lineWidth = 1 / globalScale
        ctx.strokeStyle =
          raw.id === selectedNodeId
            ? palette.nodeStrokeSelected
            : raw.id === hoveredNodeId
            ? palette.nodeStrokeHover
            : palette.nodeStroke
        ctx.stroke()

        // Initials inside the pill.
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
        ctx.font = `600 ${pillH * 0.55}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(initialsFor(raw.label), x, y + 0.5)
      }

      // Labels — only render when zoomed in enough to keep things tidy.
      // (Otherwise hundreds of overlapping labels turn the graph into mush.)
      if (globalScale > 1.1 && !dimmed) {
        const labelY = y + radius * (raw.kind === 'meeting' ? 1.4 : 1.2) + 6
        ctx.font = `500 ${10 / globalScale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
        ctx.fillStyle = palette.labelFill
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        // Truncate long labels — meeting titles can run away.
        const text = raw.label.length > 32 ? raw.label.slice(0, 30) + '…' : raw.label
        ctx.fillText(text, x, labelY)
      }

      ctx.restore()
    },
    [hoveredNodeId, neighbourhood, palette, resolveMeetingColor, searchLower, selectedNodeId]
  )

  /**
   * Link width accessor — log scale so very long talk-times don't
   * dominate visually. Min thickness 0.4px so even a zero-weight link
   * (user-added speaker with no transcript time) stays drawable.
   */
  const linkWidth = useCallback((l: unknown) => {
    const link = l as { weight?: number }
    const w = link.weight ?? 0
    return 0.4 + Math.log2(w / 30 + 1) * 0.9
  }, [])

  /**
   * Link colour accessor — dim links that aren't in the current focus
   * neighbourhood. Dashed-ish for zero-weight (user-added) links.
   */
  const linkColor = useCallback(
    (l: unknown) => {
      const link = l as { weight?: number; source: unknown; target: unknown }
      const sId = linkEndpointId(link.source)
      const tId = linkEndpointId(link.target)
      const focused =
        !neighbourhood || (neighbourhood.has(sId) && neighbourhood.has(tId))
      if (!focused) return palette.linkFill
      if ((link.weight ?? 0) === 0) return palette.linkFillDashed
      return palette.linkFillHighlight
    },
    [neighbourhood, palette]
  )

  return (
    <ForceGraph2D<NetworkNode, { weight: number }>
      ref={fgRef}
      graphData={data as unknown as { nodes: NetworkNode[]; links: { weight: number }[] }}
      width={width}
      height={height}
      backgroundColor={palette.background}
      nodeRelSize={4}
      nodeVal={(n) => n.val}
      nodeLabel={(n) => n.label}
      nodeCanvasObject={paintNode}
      nodeCanvasObjectMode={() => 'replace'}
      linkWidth={linkWidth}
      linkColor={linkColor}
      linkDirectionalParticles={0}
      onNodeClick={(n) => onNodeClick(n as NetworkNode)}
      onNodeHover={(n) => onNodeHover((n as NetworkNode) ?? null)}
      cooldownTicks={120}
      d3VelocityDecay={0.30}
      minZoom={0.4}
      maxZoom={6}
      enableNodeDrag={true}
      enablePanInteraction={true}
      enableZoomInteraction={true}
    />
  )
}

/** Accept either a string id or a node-shaped object (post-d3-force the
 *  library populates source/target with the actual node objects). */
function linkEndpointId(endpoint: unknown): string {
  if (typeof endpoint === 'string') return endpoint
  if (endpoint && typeof endpoint === 'object' && 'id' in endpoint) {
    const id = (endpoint as { id: string | number }).id
    return String(id)
  }
  return ''
}

/** Two-character initials from a name like "Pratik Kumar" → "PK". For
 *  single-word names we use the first two letters ("Bhaskar" → "BH"). */
function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Canvas rounded-rect — small helper; older Safari/macOS Electron
 *  builds didn't ship Path2D's `roundRect` until ~2023, so we draw
 *  manually to stay backwards-compatible. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, h / 2, w / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}
