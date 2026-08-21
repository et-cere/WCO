/**
 * semantic-kernel.js
 * ES module - bundled semantic core, geometry, normalization, reasoning
 * - kernel.use(plugin) to load plugins
 * - kernel.on(event, handler, priority) to register ad-hoc observers
 * - kernel.emit(event) to fire events (synchronous processing)
 * - kernel.setField(field) to store/merge semantic fields
 * - kernel.registerProcessor(proc) to add processors
 * - kernel.tick(maxIterations) to run processors until quiescent
 *
 * Exports:
 * - default export: kernel instance
 * - named exports: semanticCorePlugin, semanticGeometryPlugin,
 *                  semanticNormalizationPlugin, semanticReasoningPlugin
 *
 * This implementation is intentionally compact, deterministic, and
 * plugin-friendly. It uses in-memory stores and synchronous handlers by default.
 */

const DEFAULT_MAX_ITER = 50

// --- Kernel implementation --------------------------------------------------

function createKernel() {
  const fields = new Map() // id -> field
  const observers = [] // {event, priority, handler, pluginName}
  const processors = [] // {name, priority, run, pluginName}
  const eventLog = [] // simple event log for provenance
  const pluginRegistry = new Map()
  let registrationCounter = 0

  // Utilities
  const utilities = {
    extractKeywords(text = '', limit = 10) {
      if (!text || typeof text !== 'string') return []
      const stop = new Set([
        'the','and','or','is','a','an','of','to','in','on','for','with',
        'that','this','it','as','by','from','at','be','are','was','were'
      ])
      const tokens = text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
      const freq = {}
      for (const t of tokens) {
        if (stop.has(t)) continue
        freq[t] = (freq[t] || 0) + 1
      }
      return Object.entries(freq)
        .sort((a,b) => b[1] - a[1])
        .slice(0, limit)
        .map(x => x[0])
    },

    makeId(prefix = 'id') {
      return `${prefix}:${Math.random().toString(36).slice(2,9)}`
    }
  }

  // Core API
  const kernel = {
    utilities,
    use(plugin) {
      if (!plugin || !plugin.name) throw new Error('plugin must have a name')
      if (pluginRegistry.has(plugin.name)) {
        console.warn(`plugin ${plugin.name} already loaded`)
        return
      }
      pluginRegistry.set(plugin.name, plugin)

      // register declared field types and layers (informational)
      kernel._registeredLayers = kernel._registeredLayers || new Set()
      kernel._registeredFieldTypes = kernel._registeredFieldTypes || new Map()
      if (Array.isArray(plugin.layers)) {
        for (const l of plugin.layers) kernel._registeredLayers.add(l)
      }
      if (Array.isArray(plugin.fieldTypes)) {
        for (const ft of plugin.fieldTypes) {
          kernel._registeredFieldTypes.set(ft.name, ft)
        }
      }

      // Register observers
      if (Array.isArray(plugin.observers)) {
        for (const o of plugin.observers) {
          // ensure priority exists
          const pr = (typeof o.priority === 'number') ? o.priority : 100
          observers.push({
            event: o.event,
            priority: pr,
            handler: o.handler,
            pluginName: plugin.name,
            __order: registrationCounter++
          })
        }
      }

      // Register processors
      if (Array.isArray(plugin.processors)) {
        for (const p of plugin.processors) {
          const pr = (typeof p.priority === 'number') ? p.priority : 100
          processors.push({
            name: p.name || `proc:${kernel.utilities.makeId('proc')}`,
            priority: pr,
            run: p.run,
            pluginName: plugin.name,
            __order: registrationCounter++
          })
        }
      }

      // Sort observer and processor lists deterministically:
      // primary: priority ascending, secondary: registration order ascending
      observers.sort((a,b) => a.priority - b.priority || a.__order - b.__order)
      processors.sort((a,b) => a.priority - b.priority || a.__order - b.__order)

      // plugin init (if any) gets a limited ctx to avoid accidental mutation
      if (typeof plugin.init === 'function') {
        try {
          plugin.init({
            kernel,
            utilities,
            setField: kernel.setField,
            emit: kernel.emit,
            registerProcessor: kernel.registerProcessor,
            getSnapshot: kernel.getSnapshot
          })
        } catch (err) {
          console.error(`plugin ${plugin.name} init failed:`, err)
        }
      }
    },

    // direct observer registration
    on(event, handler, priority = 100) {
      observers.push({
        event,
        priority,
        handler,
        pluginName: '__ad_hoc__',
        __order: registrationCounter++
      })
      observers.sort((a,b) => a.priority - b.priority || a.__order - b.__order)
    },

    // emit synchronously through observers
    emit(evt) {
      if (!evt || typeof evt !== 'object') throw new Error('emit requires an event object')
      const event = {
        id: evt.id || utilities.makeId('evt'),
        type: evt.type,
        payload: evt.payload || {},
        causedBy: evt.causedBy || [],
        timestamp: new Date().toISOString()
      }
      eventLog.push(event)

      // snapshot of matching observers (so new observers added during handling don't run on current emit)
      const matching = observers.filter(o => o.event === event.type)
      for (const o of matching) {
        try {
          // provide a context object to the handler
          const ctx = {
            kernel,
            utilities,
            setField: kernel.setField,
            emit: kernel.emit,
            getSnapshot: kernel.getSnapshot,
            registerProcessor: kernel.registerProcessor,
            event: event
          }
          o.handler(event, ctx)
        } catch (err) {
          console.error(`observer error (${o.pluginName} @${o.event}):`, err)
        }
      }

      return event
    },

    // fields are merged by id. setField may be called by observers or processors.
    setField(field) {
      if (!field || typeof field !== 'object') return
      if (!field.id) field.id = utilities.makeId('field')
      const existing = fields.get(field.id)
      if (!existing) {
        // normalize some defaults
        const normalized = {
          id: field.id,
          layer: field.layer || 'semantic',
          type: field.type || 'interpretation',
          intensity: (typeof field.intensity === 'number') ? field.intensity : 1,
          volatility: (typeof field.volatility === 'number') ? field.volatility : 0,
          persistence: (typeof field.persistence === 'number') ? field.persistence : 1,
          resonance: (typeof field.resonance === 'number') ? field.resonance : 0,
          propagationRate: (typeof field.propagationRate === 'number') ? field.propagationRate : 0.02,
          decayRate: (typeof field.decayRate === 'number') ? field.decayRate : 0.005,
          metadata: field.metadata ? deepClone(field.metadata) : {},
          derivedFrom: Array.isArray(field.derivedFrom) ? [...field.derivedFrom] : []
        }
        fields.set(field.id, normalized)
      } else {
        // merge shallowly but merge metadata deeply and arrays union for derivedFrom
        const merged = {
          ...existing,
          ...field,
          metadata: {
            ...existing.metadata,
            ...(field.metadata || {})
          },
          derivedFrom: Array.from(new Set([...(existing.derivedFrom || []), ...(field.derivedFrom || [])]))
        }
        fields.set(field.id, merged)
      }
      return fields.get(field.id)
    },

    getField(id) {
      return fields.get(id)
    },

    getSnapshot() {
      // return array copy snapshot
      return Array.from(fields.values()).map(f => deepClone(f))
    },

    // processors may be registered ad-hoc
    registerProcessor(p) {
      if (!p || typeof p.run !== 'function') throw new Error('processor requires run function')
      const name = p.name || `proc:${utilities.makeId('proc')}`
      const pr = (typeof p.priority === 'number') ? p.priority : 100
      processors.push({
        name,
        priority: pr,
        run: p.run,
        pluginName: p.pluginName || '__ad_hoc__',
        __order: registrationCounter++
      })
      processors.sort((a,b) => a.priority - b.priority || a.__order - b.__order)
    },

    // run one processing pass (all processors in order), returns number of produced actions
    runProcessorsOnce() {
      const snapshot = kernel.getSnapshot()
      let produced = 0
      for (const proc of processors) {
        try {
          const result = proc.run({ fields: snapshot, kernel })
          if (Array.isArray(result)) {
            for (const r of result) {
              if (!r || typeof r !== 'object') continue
              if (r.type === 'field' && r.data) {
                kernel.setField(r.data)
                produced++
              } else if (r.type === 'event' && r.data) {
                kernel.emit(r.data)
                produced++
              }
            }
          }
        } catch (err) {
          console.error(`processor error (${proc.name}):`, err)
        }
      }
      return produced
    },

    // deterministic processing loop: run processors until no more outputs or max iterations
    tick(maxIters = DEFAULT_MAX_ITER) {
      let it = 0
      let producedTotal = 0

      // apply per-tick decay/propagation foundation before processors run
      applyDecayAndTickDynamics()

      while (it < maxIters) {
        const produced = kernel.runProcessorsOnce()
        producedTotal += produced
        it++
        // if nothing produced, we are quiescent
        if (produced === 0) break
        // take new snapshot after changes for next pass
        // Note: processors receive snapshot from getSnapshot at start of runProcessorsOnce
      }
      return { iterations: it, produced: producedTotal }
    },

    // small introspection helpers
    listFields() {
      return Array.from(fields.values()).map(f => deepClone(f))
    },

    listProcessors() {
      return processors.map(p => ({ name: p.name, priority: p.priority, plugin: p.pluginName }))
    },

    listObservers() {
      return observers.map(o => ({ event: o.event, priority: o.priority, plugin: o.pluginName }))
    },

    // simple event log access
    getEventLog() {
      return eventLog.slice()
    }
  }

  // Internal helper: apply decay and simple propagation tick mechanics
  function applyDecayAndTickDynamics() {
    for (const f of fields.values()) {
      // decay intensity
      const decayRate = (typeof f.decayRate === 'number') ? f.decayRate : 0.005
      const newIntensity = Math.max(0, f.intensity - f.intensity * decayRate)
      f.intensity = newIntensity

      // optional persistence reduction (not required; left stable)
      // f.persistence = Math.max(0, f.persistence - (f.volatility || 0) * 0.001)

      // write back to map
      fields.set(f.id, f)
    }
  }

  return kernel
}

// utility deep clone
function deepClone(x) {
  return JSON.parse(JSON.stringify(x))
}

// --- Built-in semantic plugins (adapted from provided conceptual files) ---

// semantic core plugin
export const semanticCorePlugin = {
  name: 'semantic.core',
  version: '0.1',
  layers: ['semantic'],
  fieldTypes: [
    { name: 'interpretation', domain: 'semantic' }
  ],

  observers: [
    {
      event: 'object.interpret',
      priority: 50,
      handler: (evt, ctx) => {
        const p = evt.payload || {}
        const semanticField = {
          id: p.id || ctx.kernel.utilities.makeId('sem'),
          layer: 'semantic',
          type: 'interpretation',

          intensity: (typeof p.confidence === 'number') ? p.confidence : 1.0,
          volatility: (typeof p.ambiguity === 'number') ? p.ambiguity : 0,
          persistence: 1,

          resonance: 0,
          propagationRate: (typeof p.propagationRate === 'number') ? p.propagationRate : 0.02,
          decayRate: (typeof p.decayRate === 'number') ? p.decayRate : 0.005,

          metadata: {
            themes: p.themes || ctx.kernel.utilities.extractKeywords(p.text || ''),
            relations: p.relations || {},
            ambiguity: p.ambiguity || 0,
            semantic: {} // geometry may fill this
          },

          derivedFrom: p.derivedFrom || []
        }

        ctx.setField(semanticField)
      }
    }
  ],

  init: () => {}
}

// semantic geometry plugin
export const semanticGeometryPlugin = {
  name: 'semantic.geometry',
  version: '0.1',

  processors: [
    {
      name: 'semantic-geometry-processor',
      priority: 120,

      run: ({ fields: snapshot }) => {
        const out = []
        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue

          // compute geometry vectors (pluggable overrides live in kernel._geometryOverrides)
          const meaning = (semanticGeometryPlugin._overrides && semanticGeometryPlugin._overrides.computeMeaningVector)
            ? semanticGeometryPlugin._overrides.computeMeaningVector(f, snapshot)
            : computeMeaningVector(f)
          const confidence = (semanticGeometryPlugin._overrides && semanticGeometryPlugin._overrides.computeConfidenceVector)
            ? semanticGeometryPlugin._overrides.computeConfidenceVector(f, snapshot)
            : computeConfidenceVector(f)
          const context = (semanticGeometryPlugin._overrides && semanticGeometryPlugin._overrides.computeContextVector)
            ? semanticGeometryPlugin._overrides.computeContextVector(f, snapshot)
            : computeContextVector(f, snapshot)

          const updated = {
            ...f,
            metadata: {
              ...f.metadata,
              semantic: {
                meaning,
                confidence,
                context
              }
            }
          }

          out.push({ type: 'field', data: updated })
        }
        return out
      }
    }
  ],

  // allow host environment to provide overrides like:
  // semanticGeometryPlugin._overrides = { computeMeaningVector: fn, ... }
  _overrides: null,
  init: () => {}
}

// default no-op geometry functions (replace via overrides)
function computeMeaningVector(field) {
  // placeholder: return null or sparse vector
  return null
}
function computeConfidenceVector(field) {
  return { value: field.intensity }
}
function computeContextVector(field, snapshot) {
  return null
}

// semantic normalization plugin
export const semanticNormalizationPlugin = {
  name: 'semantic.normalization',
  version: '0.1',

  observers: [
    {
      event: 'object.raw',
      priority: 40,
      handler: (evt, ctx) => {
        const p = evt.payload || {}
        const normalized = {
          id: ctx.kernel.utilities.makeId('semn'),
          layer: 'semantic',
          type: 'interpretation',

          intensity: 1.0,
          volatility: 0,
          persistence: 1,

          metadata: {
            normalized: true,
            canonical: canonicalize(p),
            themes: ctx.kernel.utilities.extractKeywords(p.text || ''),
            semantic: {}
          },

          derivedFrom: [evt.id]
        }

        ctx.setField(normalized)
        ctx.emit({ type: 'semantic.normalized', payload: { source: evt.id, out: normalized } })
      }
    }
  ],

  processors: [
    {
      name: 'semantic-normalization-pass',
      priority: 130,
      run: ({ fields: snapshot }) => {
        const out = []
        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue
          if (f.metadata?.normalized) continue

          const updated = {
            ...f,
            metadata: {
              ...f.metadata,
              normalized: true,
              canonical: canonicalize(f.metadata || {})
            }
          }

          out.push({ type: 'field', data: updated })
        }

        return out
      }
    }
  ],

  init: () => {}
}

function canonicalize(payload) {
  // Minimal placeholder canonicalizer.
  // Best to override in a domain-specific plugin.
  if (!payload) return payload
  try {
    // shallow canonicalization: remove functions and circulars (naive)
    return JSON.parse(JSON.stringify(payload))
  } catch (err) {
    return { raw: String(payload) }
  }
}

// semantic reasoning plugin
export const semanticReasoningPlugin = {
  name: 'semantic.reasoning',
  version: '0.1',

  processors: [
    {
      name: 'semantic-constraint-processor',
      priority: 140,

      run: ({ fields: snapshot, kernel }) => {
        const out = []

        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue

          const constraints = f.metadata?.constraints
          if (!Array.isArray(constraints)) continue

          const violations = checkConstraints(f, snapshot, constraints)

          if (violations.length > 0) {
            out.push({
              type: 'event',
              data: {
                type: 'semantic.anomaly',
                payload: {
                  field: f.id,
                  violations
                },
                causedBy: [f.id]
              }
            })
          }
        }

        return out
      }
    },

    {
      name: 'semantic-propagation-processor',
      priority: 150,

      run: ({ fields: snapshot }) => {
        const out = []

        for (const f of snapshot) {
          if (f.layer !== 'semantic') continue

          const relations = f.metadata?.relations || {}
          const amount = (typeof f.intensity === 'number') ? f.intensity * (f.propagationRate || 0) : 0

          if (!amount) continue

          for (const [targetId, weight] of Object.entries(relations)) {
            const target = snapshot.find(x => x.id === targetId)
            if (!target) continue

            const updated = {
              ...target,
              intensity: (typeof target.intensity === 'number' ? target.intensity : 1) + amount * weight,
              derivedFrom: Array.from(new Set([...(target.derivedFrom || []), f.id]))
            }

            out.push({ type: 'field', data: updated })
          }
        }

        return out
      }
    }
  ],

  init: () => {}
}

function checkConstraints(field, snapshot, constraints) {
  const violations = []

  for (const rule of constraints) {
    if (!rule || typeof rule !== 'object') continue

    const { type, target, condition } = rule

    if (type === 'not' && target && condition) {
      const t = snapshot.find(x => x.id === target)
      if (t && condition(field, t)) {
        violations.push({ rule, reason: 'negation violated' })
      }
    }

    if (type === 'requires' && target && condition) {
      const t = snapshot.find(x => x.id === target)
      if (!t || !condition(field, t)) {
        violations.push({ rule, reason: 'requirement violated' })
      }
    }
  }

  return violations
}

// --- Default kernel factory / instance and auto-export ----------------------

const kernel = createKernel()

// install built-in semantic plugins by default
kernel.use(semanticCorePlugin)
kernel.use(semanticNormalizationPlugin)
kernel.use(semanticGeometryPlugin)
kernel.use(semanticReasoningPlugin)

// export kernel as default
export default kernel