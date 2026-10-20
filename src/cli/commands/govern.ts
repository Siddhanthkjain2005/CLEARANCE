// `clearance release`, `clearance evidence` and `clearance sci`: what happens
// after a flight lands. A release is cut only for landed flights, and every
// release links to its tamper-evident evidence pack and carbon footprint.

import { buildEvidencePack, verifyChain } from '../../core/evidence.ts';
import { sciForFlight, type JobFootprintInput } from '../../core/sci.ts';
import { JOB_CATALOG } from '../../core/pipeline.ts';
import {
  emit, env, flightMrIid, gitlab, gitlabPackages, gitlabWriter, loadBlackBox, log, projectId, readJson, recordBlackBox, tryGit,
  upsertMrNote, warn, writeOut,
} from '../context.ts';

const now = () => new Date().toISOString();

interface ClearanceFile {
  flight: string;
  risk: { score: number; band: string };
  decision: { level: string; tier: string };
  pilot: { name: string; kind: string; trust: number };
  pipeline: { planned: string[]; avoided: JobFootprintInput[] };
}

export function nextVersion(last: string | null, title: string, labels: string[] = []): string {
  const m = (last ?? 'v0.0.0').match(/v?(\d+)\.(\d+)\.(\d+)/);
  let [maj, min, pat] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.includes('semver::major') || /^\w+(\(.+\))?!:/.test(title) || /BREAKING CHANGE/.test(title)) { maj++; min = 0; pat = 0; }
  else if (lower.includes('semver::minor') || /^feat(\(.+\))?:/i.test(title)) { min++; pat = 0; }
  else pat++;
  return `v${maj}.${min}.${pat}`;
}

export async function release() {
  const clr = readJson<ClearanceFile>('.clearance-out/clearance.json');
  if (!clr) throw new Error('missing .clearance-out/clearance.json');
  if (clr.decision.level === 'hold' || clr.decision.tier === 'taxi') {
    log(clr.decision.level === 'hold' ? 'flight is on hold; no release is cut' : 'nothing shipped changed; no release is cut');
    return;
  }
  const lastTag = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*');
  // Merge commits read "Merge branch ..."; the merge request title carries the conventional type.
  let title = tryGit('log', '-1', '--format=%s') ?? '';
  let labels = (env.CI_MERGE_REQUEST_LABELS ?? '').split(',').filter(Boolean);
  const reader = gitlab();
  const iid = flightMrIid(clr.flight);
  if (reader && iid && projectId()) {
    try {
      const mr = await reader.mergeRequest(projectId(), iid);
      title = mr.title;
      labels = mr.labels;
    } catch {
      /* job tokens can't read merge requests; fall back to the commit subject */
    }
  }
  const version = env.CLEARANCE_VERSION ?? nextVersion(lastTag, title, labels);
  const sci = readJson<{ sci: number; avoidedG: number }>('.clearance-out/sci.json');
  const notes = [
    `## ${clr.flight}: ${title}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Pilot | \`${clr.pilot.name}\` (${clr.pilot.kind}, trust ${(clr.pilot.trust * 100).toFixed(0)}%) |`,
    `| Risk | ${(clr.risk.score * 100).toFixed(1)}% (${clr.risk.band}) |`,
    `| Clearance | ${clr.decision.level} |`,
    `| Verification | ${clr.decision.tier} pipeline, ${clr.pipeline.avoided.length} job(s) avoided |`,
    `| Status | In flight: canary analysis decides whether this release lands |`,
    sci ? `| Carbon | ${sci.sci.toFixed(2)} gCO₂e for this change (${sci.avoidedG.toFixed(2)} g avoided) |` : '',
    '',
    `Evidence pack: \`clearance-evidence/${clr.flight}/evidence.json\` in this project's package registry.`,
  ].filter((l) => l !== '').join('\n');

  writeOut('.clearance-out/release.json', JSON.stringify({ version, flight: clr.flight }));
  writeOut('.clearance-out/release.md', notes);
  const g = gitlabWriter() ?? gitlab();
  if (!g || !projectId()) {
    log(`would release ${version}`);
    return;
  }
  try {
    const rel = await g.createRelease(projectId(), {
      tag_name: version,
      ref: env.CI_COMMIT_SHA,
      name: `${version} · ${clr.flight}`,
      description: notes,
      assets: {
        links: [
          {
            name: 'Evidence pack (black box)',
            url: `${env.CI_API_V4_URL}/projects/${projectId()}/packages/generic/clearance-evidence/${clr.flight}/evidence.json`,
            link_type: 'other',
          },
        ],
      },
    });
    log(`released ${rel.tag_name}`);
    await recordBlackBox(clr.flight, { stage: 'release', actor: 'clearance:release', kind: 'release', summary: `Released ${version}`, data: { version, commit: env.CI_COMMIT_SHA } });
    await emit([{ type: 'stage.passed', flight: clr.flight, at: now(), stage: 'release', job: 'clearance:release', detail: version }]);
  } catch (e) {
    warn(`could not create the release: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function evidence() {
  const clr = readJson<ClearanceFile>('.clearance-out/clearance.json');
  const flight = clr?.flight ?? env.CLEARANCE_FLIGHT;
  if (!flight) throw new Error('no flight to collect evidence for');
  const records = await loadBlackBox(flight);
  const integrity = verifyChain(records);
  if (!integrity.ok) {
    console.error(`black box for ${flight} is broken at record ${integrity.brokenAt}: evidence has been tampered with`);
    process.exitCode = 4;
    return;
  }
  const pack = buildEvidencePack({ flight, project: env.CI_PROJECT_PATH ?? 'local', commit: env.CI_COMMIT_SHA ?? 'dev', records, signingKey: env.CLEARANCE_SIGNING_KEY });
  writeOut(`evidence/${flight}.json`, JSON.stringify(pack, null, 2));
  const md = [
    `# Evidence pack ${flight}`,
    '',
    `Commit \`${pack.commit}\` · ${records.length} records · head \`${pack.head.slice(0, 16)}…\` · ${pack.signature ? 'HMAC-signed' : 'unsigned'}`,
    '',
    '| # | Stage | Actor | Record | Hash |',
    '|---|---|---|---|---|',
    ...records.map((r) => `| ${r.seq} | ${r.stage} | \`${r.actor}\` | ${r.summary.replace(/\|/g, '\\|')} | \`${r.hash.slice(0, 10)}\` |`),
    '',
    '## Controls evidenced',
    '',
    ...pack.controls.map((c) => `- **${c.framework} ${c.id}** ${c.title} (${c.satisfiedBy.join(', ')})`),
  ].join('\n');
  writeOut(`evidence/${flight}.md`, md);
  const g = gitlabPackages();
  if (g && projectId()) {
    try {
      await g.putGenericPackageFile(projectId(), 'clearance-evidence', flight, 'evidence.json', JSON.stringify(pack));
      await g.putGenericPackageFile(projectId(), 'clearance-evidence', flight, 'evidence.md', md);
    } catch (e) {
      warn(`could not upload the evidence pack: ${(e as Error).message}`);
    }
  }
  log(`evidence pack ${flight}: ${records.length} records, chain intact, ${pack.controls.length} controls evidenced`);
  await emit([
    { type: 'evidence', flight, at: now(), head: pack.head, signed: !!pack.signature, records: records.length, controls: pack.controls.map((c) => `${c.framework} ${c.id}`) },
    { type: 'stage.passed', flight, at: now(), stage: 'govern', job: 'clearance:evidence', detail: `${records.length} records` },
  ]);
  const iid = flightMrIid(flight);
  if (iid && env.CLEARANCE_EVIDENCE_NOTE === 'true') await upsertMrNote(iid, md);
}

export async function sci() {
  const clr = readJson<ClearanceFile>('.clearance-out/clearance.json');
  const region = env.CLEARANCE_RUNNER_REGION ?? 'us-east1';
  const ran: JobFootprintInput[] = [];
  const g = gitlab();
  if (g && projectId() && env.CI_PIPELINE_ID && env.CLEARANCE_TOKEN) {
    try {
      const jobs = await g.pipelineJobs(projectId(), Number(env.CI_PIPELINE_ID));
      for (const j of jobs) if (j.duration) ran.push({ name: j.name, durationSec: j.duration, status: j.status as JobFootprintInput['status'] });
      const bridges = await g.pipelineBridges(projectId(), Number(env.CI_PIPELINE_ID));
      for (const b of bridges) {
        if (!b.downstream_pipeline) continue;
        for (const j of await g.pipelineJobs(projectId(), b.downstream_pipeline.id)) {
          if (j.duration) ran.push({ name: j.name, durationSec: j.duration, status: j.status as JobFootprintInput['status'] });
        }
      }
    } catch (e) {
      warn(`could not read job durations, using typical durations: ${(e as Error).message}`);
    }
  }
  if (ran.length === 0 && clr) {
    for (const name of clr.pipeline.planned) {
      const j = JOB_CATALOG.find((c) => c.name === name);
      if (j) ran.push({ name, durationSec: j.typicalSec });
    }
  }
  const report = sciForFlight(ran, clr?.pipeline.avoided ?? [], region);
  writeOut('.clearance-out/sci.json', JSON.stringify(report, null, 2));
  // GitLab metrics report: shows up in the merge request widget.
  writeOut('metrics.txt', [
    `clearance_sci_gco2e_per_flight ${report.sci}`,
    `clearance_energy_kwh ${report.energyKwh}`,
    `clearance_avoided_gco2e ${report.avoidedG}`,
    `clearance_avoided_percent ${(report.avoidedPct * 100).toFixed(1)}`,
  ].join('\n') + '\n');
  log(`SCI ${report.sci.toFixed(3)} gCO2e per flight in ${region} (${report.intensity} g/kWh); avoided ${report.avoidedG.toFixed(3)} g (${(report.avoidedPct * 100).toFixed(0)}%)`);
  if (clr) {
    await recordBlackBox(clr.flight, { stage: 'govern', actor: 'clearance:sci', kind: 'sci', summary: `${report.sci.toFixed(3)} gCO2e per flight`, data: report });
    await emit([{ type: 'sci', flight: clr.flight, at: now(), report }]);
  }
}
