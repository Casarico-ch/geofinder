// =============================================================================
// Construction potential — an OPTIONAL, manual analysis run after the address
// is found. ONE question only: how much MORE can be built on this parcel?
//
// There is no formula hard-coded here — build potential is canton- and
// commune-specific (Geneva sets a uniform density index per zone; Zürich
// abolished the universal Ausnützungsziffer and each commune's BZO governs via
// full-floor count / height / Baumassenziffer). So this is the same "computer"
// the finder uses: the model reads the actual rule that applies to THIS parcel,
// computes the envelope, and reports it — EXACT where the regulation gives a
// number, HONEST and flagged where it is discretionary. It never fabricates.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import {
  COMPUTER_TOOLS,
  MODEL,
  clip,
  dispatchTool,
  extractReasoning,
} from "./agent";
import { addStep, addUsage, setPotential, setPotentialStatus, type Answer, type Job } from "./jobs";

const MAX_STEPS = Number(process.env.POTENTIAL_MAX_STEPS ?? 40);

export type PotentialConfidence = "exact" | "estimated" | "indicative";

// The single deliverable: how much more can be built, and on what authority.
export interface BuildPotential {
  generatedAt: string;
  headline: string; // the one-line answer the user reads
  canton: string | null;
  commune: string | null;
  zone: string | null; // zone code/designation, e.g. "5 (villa)" or "W2"
  parcelArea_m2: number | null;
  metric: string | null; // the governing rule, e.g. "IUS 0.25", "3 full floors + BMZ 0.9"
  unit: string | null; // unit of the numbers below, e.g. "m² gross floor area", "m³", "full floors"
  existing: number | null; // what's already built, in `unit`
  allowed: number | null; // max permitted by right, in `unit`
  additional: number | null; // headroom by right = allowed − existing (the headline number)
  discretionary: string | null; // extra that MAY be granted (bonuses/derogations), flagged as not guaranteed
  confidence: PotentialConfidence;
  caveats: string[];
  sources: string[];
  reasoning: string;
}

const SUBMIT_TOOL = {
  name: "submit_potential",
  description:
    "Call once, when you have determined the construction potential, to report it. Report EXACT numbers where the zone regulation gives them; where the extra potential is discretionary (a bonus, a derogation, a préavis), put it in `discretionary` and do NOT add it to `additional`. Never invent a number — if a parameter isn't published, say so in caveats and lower the confidence.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description:
          "One clear sentence: how much more can be built, by right. e.g. '≈ +240 m² gross floor area by right (IUS 0.25, villa zone)' or '≈ +1 full floor; the BZO allows 3, two are built'.",
      },
      canton: { type: ["string", "null"] },
      commune: { type: ["string", "null"] },
      zone: { type: ["string", "null"], description: "zone code/designation, e.g. '5 (villa)', 'W2', 'K'" },
      parcelArea_m2: { type: ["number", "null"] },
      metric: { type: ["string", "null"], description: "the governing rule, e.g. 'IUS 0.25', '3 Vollgeschosse + BMZ 0.9'" },
      unit: { type: ["string", "null"], description: "unit of existing/allowed/additional, e.g. 'm² gross floor area', 'm³', 'full floors'" },
      existing: { type: ["number", "null"], description: "already built, in `unit`" },
      allowed: { type: ["number", "null"], description: "max permitted by right, in `unit`" },
      additional: { type: ["number", "null"], description: "headroom by right = allowed − existing (0 if none)" },
      discretionary: {
        type: ["string", "null"],
        description: "extra that MAY be granted at permit stage (bonus/derogation/Arealüberbauung), explicitly not guaranteed",
      },
      confidence: { type: "string", enum: ["exact", "estimated", "indicative"] },
      caveats: { type: "array", items: { type: "string" } },
      sources: {
        type: "array",
        items: { type: "string" },
        description:
          "REQUIRED, non-empty: the exact URLs you actually fetched to reach this answer — the parcel query, the building/register query, the zone/regulation lookup. Every number must be traceable to one of these. Do not leave this empty.",
      },
      reasoning: { type: "string" },
    },
    required: ["headline", "confidence", "reasoning", "sources"],
  },
} as unknown as Anthropic.Messages.ToolUnion;

const TOOLS = [...COMPUTER_TOOLS, SUBMIT_TOOL];

const SYSTEM = `You are GeoFinder's construction-potential analyst. The property's address and parcel are ALREADY found. You have ONE job: determine how much MORE can be built on this exact parcel — the remaining development potential — and report it. Nothing else (no energy, noise, environment, dossier — those are out of scope).

You have a computer (bash with Node.js + fetch, write_file, read_file). There is NO built-in rule here: build potential is canton- and commune-specific, so you must READ the actual regulation that applies to THIS parcel and compute from it. Set a User-Agent header on every request.

WHAT DETERMINES POTENTIAL
Potential = (what the zone allows) − (what already exists), under the BINDING metric. Report the tightest binding envelope, by right. Steps:
1. Parcel area (m²). Geneva: SITG CAD_PARCELLE_MENSU (SURFACE). Zürich/other: geodienste av_0 ms:RESF (<ms:Flaeche>, <ms:EGRIS_EGRID>).
2. What already exists. Building footprint + floors: Geneva SITG CAD_BATIMENT_HORSOL (SURFACE footprint, NIVEAUX_HORSOL). Nationwide GWR (identify ch.bfs.gebaeude_wohnungs_register): gastw (floors), garea (footprint), ganzwhg (dwellings), gbauj. Existing gross floor area ≈ footprint × above-ground floors.
3. The zone AND its numeric parameters:
   · GENEVA — SITG SIT_ZONE_AMENAG (ZONE, NOM_ZONE). Rules (LCI): zone 5 = villa, density index (IUS) 0.25 by RIGHT; 0.4 (HPE) / 0.48 (THPE) are DISCRETIONARY derogations, restricted by loi 12920 (2023) and decided by communal préavis at permit stage — never count them as by-right. Urban zones 1–4: density follows the gabarit / any PLQ, and build-UP is governed by Geneva's official surélévation cadastre (SIT_SURELEVATION_ZONE / SIT_SURELEVATION_BATIMENT) — if the parcel is in a surélévation sector, the permitted added height/levels are the authoritative answer (read the gabarit chart link). Read the RDPPF (public-law restrictions) extract when linked.
   · ZÜRICH (and most German-speaking cantons) — there is NO universal Ausnützungsziffer since the 2014 PBG revision. Each COMMUNE's Bau- und Zonenordnung (BZO) sets, per zone: the number of full floors (Vollgeschosse), building/ridge height, often a Baumassenziffer (BMZ, m³ of building volume per m² of land), and Arealüberbauung bonuses. Get the binding zone designation at the parcel from the ÖREB-Kataster (cadastre of public-law restrictions, keyed by EGRID) or the cantonal Nutzungsplanung layer; then read that commune's BZO for the zone's parameters. Potential is then expressed in the BZO's own metric — additional full floors, or additional volume under the BMZ (allowed = BMZ × area; existing volume ≈ footprint × height), or additional GFA if the commune still uses an index. Flag Arealüberbauung / derogations as discretionary.
   · OTHER CANTON — find the commune's zone plan / building regulation (Baureglement) the same way; if the numeric parameter isn't published online, say so.

HONESTY (non-negotiable)
- Report EXACT numbers only where the regulation gives them. Compute the arithmetic yourself and show it in reasoning.
- Anything discretionary (bonus, derogation, préavis, Arealüberbauung) goes in \`discretionary\` and is NOT added to \`additional\`.
- If a needed parameter isn't published, do not guess a value — give the best-supported estimate, label it (confidence 'estimated'/'indicative'), and record what's missing in caveats.
- Confidence: 'exact' = the binding numeric rule is published and you applied it; 'estimated' = you inferred a standard value; 'indicative' = zone known but the number is discretionary/unavailable.
- Never fabricate. A truthful "the by-right envelope is essentially built out; more is only possible via a discretionary derogation" is a correct, valuable answer.
- Traceability: as you go, keep the exact URLs you fetch (parcel query, building/register query, zone/regulation lookup) and pass them ALL in \`sources\` — the list must not be empty. Every figure you report has to come from one of them.

Reason explicitly about each step — your thinking is saved as the trace. When done, call submit_potential once.`;

function seedMessage(answer: Answer): string {
  const lines = [
    "Determine the construction potential for this already-located property:",
    answer.address ? `Address: ${answer.address}` : null,
    answer.parcel ? `Parcel: ${answer.parcel}` : null,
    answer.commune ? `Commune: ${answer.commune}` : null,
    answer.latitude != null && answer.longitude != null
      ? `Coordinates (WGS84): ${answer.latitude}, ${answer.longitude}`
      : null,
    "",
    "Start from these coordinates: read the parcel area and what's already built, find the zone and its binding regulation, then compute how much more can be built by right. Be exact where the rule gives a number, honest where it's discretionary.",
  ].filter(Boolean);
  return lines.join("\n");
}

function coerce(input: Record<string, unknown>): BuildPotential {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const conf = ["exact", "estimated", "indicative"].includes(String(input.confidence))
    ? (input.confidence as PotentialConfidence)
    : "indicative";
  return {
    generatedAt: new Date().toISOString(),
    headline: String(input.headline ?? "Could not determine the construction potential."),
    canton: s(input.canton),
    commune: s(input.commune),
    zone: s(input.zone),
    parcelArea_m2: num(input.parcelArea_m2),
    metric: s(input.metric),
    unit: s(input.unit),
    existing: num(input.existing),
    allowed: num(input.allowed),
    additional: num(input.additional),
    discretionary: s(input.discretionary),
    confidence: conf,
    caveats: Array.isArray(input.caveats) ? input.caveats.filter((c): c is string => typeof c === "string") : [],
    sources: Array.isArray(input.sources) ? input.sources.filter((c): c is string => typeof c === "string") : [],
    reasoning: String(input.reasoning ?? ""),
  };
}

// Run the focused analysis. Steps are appended to the SAME job's trace (with a
// header note) and the structured result is stored on job.potential. This never
// touches the finder's status — the investigation stays "done".
export async function analyzeBuildPotential(job: Job): Promise<void> {
  const answer = job.answer;
  if (!answer || answer.latitude == null || answer.longitude == null) {
    await setPotentialStatus(job, "error");
    return;
  }
  await setPotentialStatus(job, "running");
  await addStep(job, {
    kind: "note",
    title: "— Construction potential — analysing how much more can be built",
  });

  const client = new Anthropic();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: seedMessage(answer) },
  ];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const resp = await client.messages.create({
        model: job.model ?? MODEL,
        max_tokens: 16_000,
        thinking: { type: "adaptive", display: "summarized" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        cache_control: { type: "ephemeral" },
        messages,
      });

      const u = resp.usage;
      if (u) {
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const inTok = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
        await addUsage(job, inTok, u.output_tokens ?? 0, cacheRead, cacheWrite);
      }

      const reasoning = extractReasoning(resp.content);
      if (reasoning) await addStep(job, { kind: "reasoning", title: "Reasoning", reasoning });

      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) {
        await setPotential(job, coerce({ headline: reasoning || "No conclusion.", reasoning }));
        return;
      }

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name === "submit_potential") {
          const potential = coerce(tu.input as Record<string, unknown>);
          await addStep(job, { kind: "answer", title: potential.headline, detail: potential.reasoning });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          await setPotential(job, potential);
          return;
        }
        const out = await dispatchTool(job, tu.name, tu.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }

    await setPotential(
      job,
      coerce({
        headline: "Could not conclude within the step budget.",
        confidence: "indicative",
        reasoning: `Did not converge within ${MAX_STEPS} steps.`,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addStep(job, { kind: "error", title: "Construction-potential error", detail: message });
    await setPotentialStatus(job, "error");
  }
}
