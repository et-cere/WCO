// ---------- Tier‑0 primitives ----------

export const PRIMITIVE_NAMES = [
  "Reality",
  "Information",
  "Epistemics",
  "Power",
  "Agency",
  "Incentives",
  "Trust",
  "Containment",
  "Transformation",
  "ObjectiveFunction",
];

export function loadTier0() {
  return [
    {
      name: "Reality",
      description: "The underlying world; constraints and affordances independent of any agent’s model.",
    },
    {
      name: "Information",
      description: "Signals, data, and representations that can be transmitted, stored, or transformed.",
    },
    {
      name: "Epistemics",
      description: "Processes and structures for forming, updating, and validating beliefs.",
    },
    {
      name: "Power",
      description: "Capacity to influence states, trajectories, or payoffs of others or the system.",
    },
    {
      name: "Agency",
      description: "Loci that can perceive, decide, and act with some objective function.",
    },
    {
      name: "Incentives",
      description: "Reward/penalty structures shaping agent behavior and strategy selection.",
    },
    {
      name: "Trust",
      description: "Expectations about reliability, alignment, and non‑adversarial behavior across boundaries.",
    },
    {
      name: "Containment",
      description: "Mechanisms that bound, channel, or dampen conflict and harmful dynamics.",
    },
    {
      name: "Transformation",
      description: "Mechanisms that change structures, rules, or capabilities over time.",
    },
    {
      name: "ObjectiveFunction",
      description: "What agents or systems are implicitly or explicitly optimizing.",
    },
  ];
}

// ---------- Axes (coordinate system) ----------

export function defineAxes() {
  return {
    structural: {
      kind: "Structural",
      components: ["Ontology", "Topology", "Capability"],
    },
    runtime: {
      kind: "Runtime",
      components: ["State", "Dynamics", "Outcomes"],
    },
    scope: {
      kind: "Scope",
      levels: [0, 1, 2, 3, 4, 5],
    },
    context: {
      kind: "Context",
      range: [-1, 1],
    },
    temporal: {
      kind: "Temporal",
      horizons: ["Immediate", "Short", "Medium", "Long", "Civilizational"],
    },
  };
}

// ---------- State vector ----------

export class StateVector {
  constructor() {
    this.variables = new Map();
  }

  has(id) {
    return this.variables.has(id);
  }

  register(meta, initialValue = null) {
    if (!this.variables.has(meta.id)) {
      this.variables.set(meta.id, { meta, value: initialValue });
    }
  }

  set(id, value) {
    const v = this.variables.get(id);
    if (!v) throw new Error(`Variable not found: ${id}`);
    v.value = value;
  }

  get(id) {
    const v = this.variables.get(id);
    if (!v) throw new Error(`Variable not found: ${id}`);
    return v.value;
  }

  list() {
    return Array.from(this.variables.values());
  }
}

// ---------- Dynamics engine ----------

export class DynamicsEngine {
  constructor() {
    this.rules = [];
  }

  registerRule(rule) {
    this.rules.push(rule);
    this.rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  step(ctx) {
    for (const rule of this.rules) {
      rule.update(ctx);
    }
  }
}

// ---------- Regions ----------

export class RegionRegistry {
  constructor() {
    this.regions = new Map();
  }

  register(region) {
    this.regions.set(region.id, region);
  }

  list() {
    return Array.from(this.regions.values());
  }

  activeRegions(state) {
    return this.list().filter((r) => r.test(state));
  }
}

// ---------- Transforms ----------

export class TransformRegistry {
  constructor() {
    this.transforms = new Map();
  }

  register(transform) {
    this.transforms.set(transform.id, transform);
  }

  run(id, state) {
    const t = this.transforms.get(id);
    if (!t) throw new Error(`Transform not found: ${id}`);
    return t.apply(state);
  }
}

// ---------- Substrate core ----------

export class Substrate {
  constructor(config = {}) {
    this.primitives = loadTier0();
    this.axes = defineAxes();
    this.state = new StateVector();
    this.dynamics = new DynamicsEngine();
    this.regions = new RegionRegistry();
    this.transforms = new TransformRegistry();

    this.time = config.initialTime ?? 0;
    this.dt = config.dt ?? 1;
    this.params = config.params ?? {};

    this.plugins = [];
  }

  loadPlugin(plugin) {
    const ctx = {
      primitives: this.primitives,
      axes: this.axes,
      state: this.state,
      dynamics: this.dynamics,
      regions: this.regions,
      transforms: this.transforms,
    };
    plugin.register(ctx);
    this.plugins.push(plugin);
  }

  step() {
    const ctx = {
      state: this.state,
      time: this.time,
      dt: this.dt,
      params: this.params,
    };
    this.dynamics.step(ctx);
    this.time += this.dt;
  }

  run(steps) {
    for (let i = 0; i < steps; i++) this.step();
  }
}

// ---------- Domain spec ingestion ----------
//
// Spec shape (example):
//
// const coordinationSpec = {
//   id: "coordination",
//   variables: {
//     T: { initial: 0.5 },
//     C: { initial: 0.5 },
//     E: { initial: 0.5 },
//     G: { initial: 0.5 },
//     P: { initial: 0.5 },
//     kappa: { initial: 0.5 }
//   },
//   dynamics: [
//     {
//       id: "trust_update",
//       order: 1,
//       inputs: ["T", "E", "C", "G"],
//       output: "T",
//       rule: "0.45*E + 0.35*C - 0.55*G - 0.25*(T-0.5)"
//     }
//   ],
//   regions: {
//     stable_peace: "T>0.75 && C>0.7 && G<0.25",
//     hot_war: "T<0.3 && C<0.35 && G>0.7"
//   },
//   transforms: {
//     conflict_risk: "0.6*G + 0.4*(1-C) + 0.3*(1-T)"
//   }
// };

export function applyDomainSpec(substrate, spec) {
  const { state, dynamics, regions, transforms } = substrate;

  // Variables
  if (spec.variables) {
    for (const [id, cfg] of Object.entries(spec.variables)) {
      if (!state.has(id)) {
        state.register({ id, label: cfg.label ?? id }, cfg.initial ?? 0.5);
      }
    }
  }

  // Dynamics
  if (spec.dynamics) {
    for (const ruleSpec of spec.dynamics) {
      const { id, order, inputs = [], output, rule } = ruleSpec;
      const fn = buildRuleFunction(inputs, output, rule);
      dynamics.registerRule({
        id,
        order,
        update: ({ state, dt }) => fn(state, dt),
      });
    }
  }

  // Regions
  if (spec.regions) {
    for (const [id, expr] of Object.entries(spec.regions)) {
      const testFn = buildPredicateFunction(expr);
      regions.register({
        id,
        label: id,
        test: (s) => testFn(s),
      });
    }
  }

  // Transforms
  if (spec.transforms) {
    for (const [id, expr] of Object.entries(spec.transforms)) {
      const tf = buildTransformFunction(expr);
      transforms.register({
        id,
        label: id,
        apply: (s) => tf(s),
      });
    }
  }
}

// ---------- Helpers: expression → functions ----------

function buildRuleFunction(inputs, output, expr) {
  // Build a function(state, dt) that:
  // 1. reads inputs from state
  // 2. evaluates expr
  // 3. writes to output
  //
  // expr is something like: "0.45*E + 0.35*C - 0.55*G - 0.25*(T-0.5)"

  const argList = inputs.join(", ");
  const body = `
    const clamp01 = x => Math.max(0, Math.min(1, x));
    const next = ${expr};
    state.set("${output}", clamp01(next));
  `;
  // eslint-disable-next-line no-new-func
  const fn = new Function("state", "dt", ...inputs, body);
  return (state, dt) => {
    const values = inputs.map((id) => Number(state.get(id)));
    fn(state, dt, ...values);
  };
}

function buildPredicateFunction(expr) {
  // expr like: "T>0.75 && C>0.7 && G<0.25"
  const body = `
    return (${expr});
  `;
  // eslint-disable-next-line no-new-func
  const fn = new Function("state", "T", "C", "E", "G", "P", "kappa", body);
  return (state) => {
    const T = Number(state.get("T") ?? 0);
    const C = Number(state.get("C") ?? 0);
    const E = Number(state.get("E") ?? 0);
    const G = Number(state.get("G") ?? 0);
    const P = Number(state.get("P") ?? 0);
    const kappa = Number(state.get("kappa") ?? 0);
    return !!fn(state, T, C, E, G, P, kappa);
  };
}

function buildTransformFunction(expr) {
  // expr like: "0.6*G + 0.4*(1-C) + 0.3*(1-T)"
  const body = `
    const clamp01 = x => Math.max(0, Math.min(1, x));
    return clamp01(${expr});
  `;
  // eslint-disable-next-line no-new-func
  const fn = new Function("state", "T", "C", "E", "G", "P", "kappa", body);
  return (state) => {
    const T = Number(state.get("T") ?? 0);
    const C = Number(state.get("C") ?? 0);
    const E = Number(state.get("E") ?? 0);
    const G = Number(state.get("G") ?? 0);
    const P = Number(state.get("P") ?? 0);
    const kappa = Number(state.get("kappa") ?? 0);
    return fn(state, T, C, E, G, P, kappa);
  };
}
