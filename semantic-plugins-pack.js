/**
 * semantic-plugins-pack.js
 * ES module - a pack of semantic plugins to extend the semantic kernel.
 *
 * Plugins included:
 *  - semantic.drift         : detects drift in semantic fields over time
 *  - semantic.compression   : compresses / merges similar semantic fields
 *  - semantic.counterfactual: generates counterfactual variants of fields
 *  - semantic.provenance    : enriches fields with provenance records
 *  - semantic.alignment     : aligns semantics across domains / namespaces
 *
 * Each plugin is self-contained and plugin-friendly:
 *  - Designed to be loaded with kernel.use(plugin)
 *  - Use plugin.init(ctx) to tune thresholds or provide override hooks
 *  - Emit events and produce field updates via the kernel API
 *
 * Notes:
 *  - All numeric vector math is optional: plugins gracefully fall back
 *    to theme overlap / string heuristics if no meaning vectors are present.
 *  - Plugins are deterministic and use priority ordering. You can override
 *    behavior by registering custom processors/observers or by setting the
 *    plugin._overrides object before or after registration.
 *
 * Example:
 *  import kernel, { semanticDriftPlugin, registerAll } from './semantic-kernel.js'
 *  kernel.use(semanticDriftPlugin)
 *  // or:
 *  registerAll(kernel) // convenience to load the whole pack
 */

/* Utility helpers used by multiple plugins */
function dot(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] || 0) * (b[i] || 0)
  return s
}
function norm(a = []) {
  if (!Array.isArray(a)) return 0
  return Math.sqrt(a.reduce((s, v) => s + (v || 0) * (v || 0), 0))
}
function cosine(a, b) {
  const na = norm(a), nb = norm(b)
  if (na === 0 || nb === 0) return 0
  return dot(a, b) / (na * nb)
}
function themesOverlap(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const sa = new Set(a), sb = new Set(b)
  let c = 0
  for (const t of sa) if (sb.has(t)) c++
  return c / Math.max(1, Math.max(sa.size, sb.size))
}
function shallowClone(x) { return Object.assign({}, x) }

/* -------------------------------------------------------------------------- */
/* 1) Semantic Drift plugin                                                   */
/*    - Detects when a field's meaning vector diverges from previous state   */
/*    - Emits 'semantic.drift' events with delta info                         */
/* -------------------------------------------------------------------------- */
export const semanticDriftPlugin = {
  name: 'semantic.drift',
  version: '0.1',
  processors: [
    {
      name: 'semantic-drift-detector',
      priority: 200,
      run: ({ fields: snapshot, kernel }) => {
        const out = []
        const K = kernel || {}
        const store = semanticDriftPlugin._store || new Map()

        // thresholds (can be tuned via _overrides or init)
        const driftThreshold = (semanticDriftPlugin._overrides && semanticDriftPlugin._overrides.driftThreshold) || 0.25
        const useCosine = (semanticDriftPlugin._overrides && semanticDriftPlugin._overrides.useCosine) ?? true

        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue

          // extract current meaning vector or themes as fallback
          const currentVec = f.metadata?.semantic?.meaning || null
          const currentThemes = f.metadata?.themes || []

          const key = f.id
          const prev = store.get(key)

          if (!prev) {
            // first-seen; store baseline summary
            store.set(key, {
              seenAt: new Date().toISOString(),
              meaning: currentVec,
              themes: currentThemes,
              intensity: f.intensity
            })
            continue
          }

          let score = 0
          if (currentVec && prev.meaning && useCosine) {
            score = 1 - cosine(currentVec, prev.meaning) // drift as 1 - similarity
          } else {
            // fallback: themes overlap
            score = 1 - themesOverlap(currentThemes, prev.themes)
          }

          if (score >= driftThreshold) {
            out.push({
              type: 'event',
              data: {
                type: 'semantic.drift',
                payload: {
                  field: f.id,
                  driftScore: score,
                  previous: { meaning: prev.meaning, themes: prev.themes, intensity: prev.intensity },
                  current: { meaning: currentVec, themes: currentThemes, intensity: f.intensity },
                  detectedAt: new Date().toISOString()
                },
                causedBy: [f.id]
              }
            })

            // update baseline to current (exponential moving average could be used instead)
            store.set(key, {
              seenAt: new Date().toISOString(),
              meaning: currentVec,
              themes: currentThemes,
              intensity: f.intensity
            })
          } else {
            // light update to keep baseline fresh but not overwrite on small noise
            // keep existing meaning unless overrides specify to update
            if (semanticDriftPlugin._overrides?.updateBaselineOnNoDrift) {
              store.set(key, {
                seenAt: new Date().toISOString(),
                meaning: currentVec || prev.meaning,
                themes: currentThemes.length ? currentThemes : prev.themes,
                intensity: f.intensity
              })
            }
          }
        }

        // persist store reference in plugin for later introspection
        semanticDriftPlugin._store = store

        return out
      }
    }
  ],
  init(ctx) {
    // allow host to inspect the store via ctx.kernel.plugins? We attach nothing extra here.
  },
  _overrides: null,
  _store: null
}

/* -------------------------------------------------------------------------- */
/* 2) Semantic Compression plugin                                             */
/*    - Identifies clusters of similar fields and produces compressed fields  */
/*    - Adds metadata.compressedBy on originals and produces a new field that */
/*      summarizes the group                                                  */
/* -------------------------------------------------------------------------- */
export const semanticCompressionPlugin = {
  name: 'semantic.compression',
  version: '0.1',
  processors: [
    {
      name: 'semantic-compression-processor',
      priority: 210,
      run: ({ fields: snapshot, kernel }) => {
        const out = []
        const minGroupSize = (semanticCompressionPlugin._overrides && semanticCompressionPlugin._overrides.minGroupSize) || 2
        const similarityThreshold = (semanticCompressionPlugin._overrides && semanticCompressionPlugin._overrides.similarityThreshold) || 0.92
        const used = new Set()

        // naive O(n^2) clustering by pairwise similarity (keeps implementation tiny)
        for (let i = 0; i < snapshot.length; i++) {
          const a = snapshot[i]
          if (a.layer !== 'semantic') continue
          if (used.has(a.id)) continue

          const cluster = [a]
          for (let j = i + 1; j < snapshot.length; j++) {
            const b = snapshot[j]
            if (b.layer !== 'semantic') continue
            if (used.has(b.id)) continue

            let sim = 0
            const va = a.metadata?.semantic?.meaning
            const vb = b.metadata?.semantic?.meaning
            if (Array.isArray(va) && Array.isArray(vb)) {
              sim = cosine(va, vb)
            } else {
              sim = themesOverlap(a.metadata?.themes || [], b.metadata?.themes || [])
            }
            if (sim >= similarityThreshold) cluster.push(b)
          }

          if (cluster.length >= minGroupSize) {
            // mark originals as compressed (metadata.compressedBy)
            const compressedId = (semanticCompressionPlugin._overrides && semanticCompressionPlugin._overrides.makeCompressedId)
              ? semanticCompressionPlugin._overrides.makeCompressedId(cluster)
              : `cmp:${Math.random().toString(36).slice(2,9)}`

            // create compressed summary field
            // summary meaning: elementwise mean of vectors if available, else union of themes
            let meaning = null
            const vecs = cluster.map(x => x.metadata?.semantic?.meaning).filter(Boolean)
            if (vecs.length > 0) {
              const len = Math.max(...vecs.map(v => v.length))
              meaning = new Array(len).fill(0)
              for (const v of vecs) for (let k = 0; k < len; k++) meaning[k] += (v[k] || 0)
              for (let k = 0; k < len; k++) meaning[k] /= vecs.length
            }
            const themes = Array.from(new Set(cluster.flatMap(x => x.metadata?.themes || [])))

            const compressedField = {
              id: compressedId,
              layer: 'semantic',
              type: 'interpretation',
              intensity: Math.max(...cluster.map(x => x.intensity || 1)),
              volatility: Math.max(...cluster.map(x => x.volatility || 0)),
              persistence: Math.max(...cluster.map(x => x.persistence || 1)),
              metadata: {
                compressed: true,
                members: cluster.map(x => x.id),
                themes,
                semantic: {
                  meaning,
                  confidence: { value: cluster.reduce((s, c) => s + (c.metadata?.semantic?.confidence?.value || 0), 0) / Math.max(1, cluster.length) }
                }
              },
              derivedFrom: cluster.flatMap(x => x.derivedFrom || [])
            }

            out.push({ type: 'field', data: compressedField })

            // update originals with compressedBy pointer
            for (const member of cluster) {
              used.add(member.id)
              const updatedOrig = shallowClone(member)
              updatedOrig.metadata = { ...(updatedOrig.metadata || {}), compressedBy: compressedId }
              out.push({ type: 'field', data: updatedOrig })
            }
          }
        }

        return out
      }
    }
  ],
  init() {},
  _overrides: null
}

/* -------------------------------------------------------------------------- */
/* 3) Semantic Counterfactuals plugin                                          */
/*    - Produces lightweight counterfactual variants of selected fields       */
/*    - Adds metadata.counterfactuals listing variants and causal notes       */
/* -------------------------------------------------------------------------- */
export const semanticCounterfactualsPlugin = {
  name: 'semantic.counterfactuals',
  version: '0.1',
  observers: [
    {
      // listen to interpreted fields and optionally emit counterfactuals
      event: 'object.interpret',
      priority: 60,
      handler: (evt, ctx) => {
        const p = evt.payload || {}
        const kernel = ctx.kernel
        const make = semanticCounterfactualsPlugin._overrides?.makeCounterfactuals || defaultMakeCounterfactuals

        // only generate if user asked for counterfactuals or if payload carries cue
        const cue = p.generateCounterfactuals || false
        if (!cue) return

        const baseField = {
          id: p.id || ctx.kernel.utilities.makeId('cf:base'),
          layer: 'semantic',
          type: 'interpretation',
          intensity: p.confidence ?? 1.0,
          metadata: {
            themes: p.themes || ctx.kernel.utilities.extractKeywords(p.text || ''),
            semantic: p.semantic || {}
          },
          derivedFrom: p.derivedFrom || []
        }

        const variants = make(baseField, { kernel, evt, plugin: semanticCounterfactualsPlugin })

        for (const v of variants) {
          kernel.setField(v)
          kernel.emit({ type: 'semantic.counterfactual.generated', payload: { base: baseField.id, out: v } })
        }
      }
    }
  ],
  processors: [
    {
      name: 'semantic-counterfactuals-processor',
      priority: 220,
      run: ({ fields: snapshot }) => {
        // passive: nothing automatic here; observer-driven generation preferred.
        return []
      }
    }
  ],
  init(ctx) {},
  _overrides: null
}

function defaultMakeCounterfactuals(baseField, ctx) {
  // create 2 basic counterfactuals:
  //  - stronger: increase intensity and confidence
  //  - alternate: perturb themes / meaning slightly
  const kern = ctx.kernel
  const v1 = shallowClone(baseField)
  v1.id = kern.utilities.makeId('cf:strong')
  v1.intensity = Math.min(1, (baseField.intensity || 1) * 1.2)
  v1.metadata = { ...(v1.metadata || {}), counterfactualOf: baseField.id, note: 'strengthened' }
  v1.derivedFrom = [...(baseField.derivedFrom || []), baseField.id]

  const v2 = shallowClone(baseField)
  v2.id = kern.utilities.makeId('cf:alt')
  // perturb themes by swapping one theme or appending a neighboring token
  const themes = Array.from(new Set([...(baseField.metadata?.themes || [])]))
  if (themes.length > 0) themes[0] = themes[0] + '_alt'
  else themes.push('alternative')
  v2.metadata = { ...(v2.metadata || {}), counterfactualOf: baseField.id, themes }
  v2.derivedFrom = [...(baseField.derivedFrom || []), baseField.id]
  return [v1, v2]
}

/* -------------------------------------------------------------------------- */
/* 4) Semantic Provenance plugin                                               */
/*    - Ensures fields carry provenance metadata and emits provenance events  */
/*    - Hooks object.raw / object.interpret and semantic.normalized to attach  */
/*      event references and readable lineage                                    */
/* -------------------------------------------------------------------------- */
export const semanticProvenancePlugin = {
  name: 'semantic.provenance',
  version: '0.1',
  observers: [
    {
      event: 'object.raw',
      priority: 30,
      handler: (evt, ctx) => {
        // annotate the raw event with a provenance stub (no field yet)
        // store minimal mapping in plugin store for later linking
        semanticProvenancePlugin._eventMap = semanticProvenancePlugin._eventMap || new Map()
        semanticProvenancePlugin._eventMap.set(evt.id, { type: 'raw', timestamp: evt.timestamp })
      }
    },

    {
      event: 'object.interpret',
      priority: 50,
      handler: (evt, ctx) => {
        // when a field is created from interpret, ensure derivedFrom includes the event id
        // handlers earlier in pipeline may already set derivedFrom; we merge
        const p = evt.payload || {}
        if (!p || !p.id) return
        // canonicalize derivedFrom if present
        const derived = Array.isArray(p.derivedFrom) ? [...p.derivedFrom] : []
        if (!derived.includes(evt.id)) derived.push(evt.id)

        // produce a field update that merges derivedFrom; kernel will merge
        ctx.setField({ id: p.id, derivedFrom: derived })
      }
    },

    {
      event: 'semantic.normalized',
      priority: 45,
      handler: (evt, ctx) => {
        // semantic.normalized payload: { source: evt.id, out: normalized }
        const payload = evt.payload || {}
        const out = payload.out
        if (!out) return
        const baselineProvenance = {
          createdByEvent: payload.source,
          createdAt: new Date().toISOString(),
          note: 'normalized'
        }
        // attach provenance record inside metadata.provenance (array)
        const updated = {
          id: out.id,
          metadata: {
            ...(out.metadata || {}),
            provenance: [...(out.metadata?.provenance || []), baselineProvenance]
          }
        }
        ctx.setField(updated)
      }
    }
  ],

  processors: [
    {
      name: 'semantic-provenance-consolidator',
      priority: 230,
      run: ({ fields: snapshot }) => {
        // Build richer provenance entries where possible (no external IO)
        const out = []
        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue
          const prov = f.metadata?.provenance || []
          // If we have derivedFrom event ids, ensure provenance references them
          const derived = f.derivedFrom || []
          const missing = derived.filter(d => !prov.some(p => p.createdByEvent === d))
          if (missing.length) {
            const additions = missing.map(d => ({ createdByEvent: d, createdAt: new Date().toISOString(), note: 'derived' }))
            const updated = {
              ...f,
              metadata: { ...(f.metadata || {}), provenance: [...prov, ...additions] }
            }
            out.push({ type: 'field', data: updated })
          }
        }
        return out
      }
    }
  ],

  init() {
    semanticProvenancePlugin._eventMap = semanticProvenancePlugin._eventMap || new Map()
  },

  _eventMap: null
}

/* -------------------------------------------------------------------------- */
/* 5) Cross-Domain Semantic Alignment plugin                                  */
/*    - Finds alignments between fields tagged with different domains/namespaces
 *    - Adds metadata.relations alignment edges and emits 'semantic.aligned'
 * -------------------------------------------------------------------------- */
export const semanticAlignmentPlugin = {
  name: 'semantic.alignment',
  version: '0.1',
  processors: [
    {
      name: 'semantic-cross-domain-aligner',
      priority: 240,
      run: ({ fields: snapshot, kernel }) => {
        const out = []
        const alignThreshold = (semanticAlignmentPlugin._overrides && semanticAlignmentPlugin._overrides.alignThreshold) || 0.85

        // group fields by domain tag (metadata.domain) - skip unlabeled ones
        const groups = {}
        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue
          const d = f.metadata?.domain || 'default'
          if (!groups[d]) groups[d] = []
          groups[d].push(f)
        }

        const domains = Object.keys(groups)
        if (domains.length < 2) return out

        // cross domain pairwise alignments
        for (let i = 0; i < domains.length; i++) {
          for (let j = i + 1; j < domains.length; j++) {
            const A = groups[domains[i]]
            const B = groups[domains[j]]

            for (const a of A) {
              for (const b of B) {
                // compute alignment score via meaning vectors or themes fallback
                let score = 0
                const va = a.metadata?.semantic?.meaning
                const vb = b.metadata?.semantic?.meaning
                if (Array.isArray(va) && Array.isArray(vb)) score = cosine(va, vb)
                else score = themesOverlap(a.metadata?.themes || [], b.metadata?.themes || [])

                if (score >= alignThreshold) {
                  // add relations both ways if not already present
                  const relA = { ...(a.metadata?.relations || {}) }
                  const relB = { ...(b.metadata?.relations || {}) }

                  // record an alignment edge with score
                  relA[b.id] = score
                  relB[a.id] = score

                  const updatedA = { id: a.id, metadata: { ...(a.metadata || {}), relations: relA } }
                  const updatedB = { id: b.id, metadata: { ...(b.metadata || {}), relations: relB } }

                  out.push({ type: 'field', data: updatedA })
                  out.push({ type: 'field', data: updatedB })

                  // emit alignment event
                  out.push({
                    type: 'event',
                    data: {
                      type: 'semantic.aligned',
                      payload: { a: a.id, b: b.id, score, domainA: domains[i], domainB: domains[j], at: new Date().toISOString() },
                      causedBy: [a.id, b.id]
                    }
                  })
                }
              }
            }
          }
        }

        return out
      }
    }
  ],
  init() {},
  _overrides: null
}

/* -------------------------------------------------------------------------- */
/* Convenience: register all plugins in a safe order                           */
/* -------------------------------------------------------------------------- */
export function registerAll(kernel) {
  // recommended order based on priorities and semantics
  const list = [
    semanticProvenancePlugin,
    semanticCounterfactualsPlugin,
    semanticDriftPlugin,
    semanticCompressionPlugin,
    semanticAlignmentPlugin
  ]
  for (const p of list) kernel.use(p)
  return kernel
}

/* Exports for individual plugins and helpers */
export default {
  semanticDriftPlugin,
  semanticCompressionPlugin,
  semanticCounterfactualsPlugin,
  semanticProvenancePlugin,
  semanticAlignmentPlugin,
  registerAll
}