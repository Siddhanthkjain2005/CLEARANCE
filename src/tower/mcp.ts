// Model Context Protocol server (Streamable HTTP transport, JSON responses).
//
// GitLab Duo agents connect to this endpoint as an MCP client (see
// .gitlab/duo/mcp.json) and use it to plan *for* clearance: a Dispatcher can
// ask what a change touching src/core would be cleared as before writing a
// line, then scope the work to stay within the autonomy its pilot has earned.

import { analyzeCanary } from '../core/canary.ts';
import { decide } from '../core/governor.ts';
import { assessRisk } from '../core/risk.ts';
import { scorePilot } from '../core/trust.ts';
import { GRID_INTENSITY, greenestRegion } from '../core/sci.ts';
import type { Airspace, ChangeSet, FileChange, SecurityFinding } from '../core/types.ts';
import type { Store } from './store.ts';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

const fileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    additions: { type: 'integer', minimum: 0 },
    deletions: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed'] },
  },
  required: ['path', 'additions', 'deletions'],
};

const sampleSchema = {
  type: 'object',
  properties: {
    requests: { type: 'integer', minimum: 0 },
    errors: { type: 'integer', minimum: 0 },
    latencies_ms: { type: 'array', items: { type: 'number' }, maxItems: 20000 },
  },
  required: ['requests', 'errors', 'latencies_ms'],
};

export class McpServer {
  private store: Store;
  private airspace: Airspace;
  private budget: () => number;
  private tools: Tool[];

  constructor(store: Store, airspace: Airspace, budget: () => number) {
    this.store = store;
    this.airspace = airspace;
    this.budget = budget;
    this.tools = this.defineTools();
  }

  private defineTools(): Tool[] {
    return [
      {
        name: 'assess_change',
        title: 'Assess a proposed change',
        description:
          'Score a proposed change with the Clearance risk model and return the clearance level the governor would issue. ' +
          'Use it before writing code to keep a change within the autonomy the pilot has earned (smaller, tested, fewer sectors).',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            pilot: { type: 'string', description: 'Service account or username flying the change' },
            author_kind: { type: 'string', enum: ['agent', 'human'] },
            files: { type: 'array', items: fileSchema, minItems: 1, maxItems: 500 },
            findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, scanner: { type: 'string' }, name: { type: 'string' } } } },
          },
          required: ['files'],
        },
        run: (a) => {
          const files = (a.files as FileChange[]).slice(0, 500).map((f) => ({ path: String(f.path), additions: Math.max(0, Number(f.additions) || 0), deletions: Math.max(0, Number(f.deletions) || 0), status: f.status }));
          const pilot = typeof a.pilot === 'string' ? a.pilot : 'ai-clearance-dispatch';
          const kind = a.author_kind === 'human' ? 'human' : 'agent';
          const change: ChangeSet = { title: String(a.title ?? 'proposed change'), author: pilot, authorKind: kind, files, findings: (a.findings as SecurityFinding[]) ?? [] };
          const risk = assessRisk(change, this.airspace);
          const trust = scorePilot(pilot, this.store.ledgerEntries().filter((e) => e.pilot === pilot), this.store.policy);
          const decision = decide({ change, risk, trust, errorBudget: this.budget(), policy: this.store.policy });
          return {
            level: decision.level,
            risk: { score: risk.score, band: risk.band, signals: risk.signals, sectors: risk.sectors.map((s) => s.sector) },
            trust: trust.trust,
            allowance: decision.allowance,
            reasons: decision.reasons,
            pipeline_tier: decision.tier,
            canary: decision.canary,
            advice:
              decision.level === 'autonomous'
                ? 'Within the earned allowance. Keep the change as scoped as proposed.'
                : `To fly autonomously, bring risk below ${(decision.allowance * 100).toFixed(0)}%: split the change by sector, add tests next to shipped code, and avoid dependency or protected-sector edits.`,
          };
        },
      },
      {
        name: 'get_flight',
        title: 'Get a flight',
        description: 'Return one flight (CLR-<merge request iid> or INT-<issue iid>) with its stages, risk, clearance, canary verdict, carbon and evidence.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Z]{3}-[0-9a-f]+$' } }, required: ['id'] },
        run: (a) => this.store.flights.get(String(a.id)) ?? { error: `no flight ${a.id}` },
      },
      {
        name: 'list_flights',
        title: 'List flights',
        description: 'List recent flights, optionally filtered by phase (airborne, holding, landed, go-around, diverted).',
        inputSchema: { type: 'object', properties: { phase: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
        run: (a) =>
          this.store
            .flightList()
            .filter((f) => !a.phase || f.phase === a.phase)
            .slice(0, Math.min(50, Number(a.limit) || 15))
            .map((f) => ({ id: f.id, title: f.title, pilot: f.pilot, phase: f.phase, stage: f.current, level: f.level, risk: f.risk?.score ?? null, url: f.url })),
      },
      {
        name: 'trust_ledger',
        title: 'Trust ledger',
        description: 'Earned trust per pilot: conservative trust score, flights, go-arounds, clean-landing streak and how many landings remain before autonomy.',
        inputSchema: { type: 'object', properties: { pilot: { type: 'string' } } },
        run: (a) => this.store.agents().filter((s) => !a.pilot || s.pilot === a.pilot),
      },
      {
        name: 'error_budget',
        title: 'Error budget',
        description: 'Remaining SLO error budget (0..1) and how it currently scales autonomy.',
        inputSchema: { type: 'object', properties: {} },
        run: () => {
          const remaining = this.budget();
          const p = this.store.policy.errorBudget;
          return { remaining, tighten_below: p.tightenBelow, freeze_below: p.freezeBelow, state: remaining <= p.freezeBelow ? 'frozen: only fixes fly' : remaining < p.tightenBelow ? 'tightened' : 'normal' };
        },
      },
      {
        name: 'explain_policy',
        title: 'Explain the autonomy policy',
        description: 'Return the autonomy thresholds, hold conditions, canary plans and sector map the governor enforces.',
        inputSchema: { type: 'object', properties: {} },
        run: () => ({ policy: this.store.policy, sectors: this.airspace.sectors }),
      },
      {
        name: 'analyze_canary',
        title: 'Analyse canary samples',
        description: 'Run the canary statistics (two-proportion z-test, Mann–Whitney U, SLO burn rate) on baseline and canary samples.',
        inputSchema: { type: 'object', properties: { baseline: sampleSchema, canary: sampleSchema }, required: ['baseline', 'canary'] },
        run: (a) => {
          const conv = (s: Record<string, unknown>, revision: string) => ({ revision, requests: Number(s.requests) || 0, errors: Number(s.errors) || 0, latenciesMs: ((s.latencies_ms as number[]) ?? []).slice(0, 20_000).map(Number) });
          return analyzeCanary(conv(a.baseline as Record<string, unknown>, 'baseline'), conv(a.canary as Record<string, unknown>, 'canary'), this.store.policy);
        },
      },
      {
        name: 'carbon_report',
        title: 'Carbon report',
        description: 'Software Carbon Intensity totals across recent flights and the lowest-carbon Google Cloud regions to run in.',
        inputSchema: { type: 'object', properties: { candidate_regions: { type: 'array', items: { type: 'string' } } } },
        run: (a) => {
          const candidates = Array.isArray(a.candidate_regions) && a.candidate_regions.length ? (a.candidate_regions as string[]) : Object.keys(GRID_INTENSITY);
          return { totals: this.store.carbon(), greenest: greenestRegion(candidates), unit: 'gCO2e per change shipped' };
        },
      },
    ];
  }

  private ok(id: JsonRpcRequest['id'], result: unknown) {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private err(id: JsonRpcRequest['id'], code: number, message: string) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  handle(req: JsonRpcRequest): object | null {
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return this.err(req?.id, -32600, 'Invalid Request');
    const isNotification = req.id === undefined;
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '');
        return this.ok(req.id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clearance-tower', title: 'Clearance Tower', version: '1.0.0' },
          instructions:
            'Clearance decides how much autonomy each change gets. Call assess_change before implementing to keep the change within the earned allowance; ' +
            'call get_flight or list_flights to see what is in the air; trust_ledger shows what each pilot has earned.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return this.ok(req.id, {});
      case 'tools/list':
        return this.ok(req.id, {
          tools: this.tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })),
        });
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return this.err(req.id, -32602, `Unknown tool: ${name}`);
        try {
          const result = tool.run((req.params?.arguments as Record<string, unknown>) ?? {});
          const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : { items: result };
          return this.ok(req.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: structured, isError: false });
        } catch (e) {
          return this.ok(req.id, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
        }
      }
      default:
        return isNotification ? null : this.err(req.id, -32601, `Method not found: ${req.method}`);
    }
  }

  handleBody(body: unknown): object | object[] | null {
    if (Array.isArray(body)) {
      const out = body.map((r) => this.handle(r as JsonRpcRequest)).filter((x): x is object => x !== null);
      return out.length ? out : null;
    }
    return this.handle(body as JsonRpcRequest);
  }
}
