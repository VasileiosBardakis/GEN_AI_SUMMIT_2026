import type { Step, Verdict, Workflow } from "@gen/shared";

export type Candidate = {
  workflow: Workflow;
  repetitions: number;
  minutesPerWeek: number;
  stability: number;
};

export type StatsDecision = {
  verdict: Verdict;
  confidence: number;
  features: Record<string, number>;
};

export type StatsDeciderConfig = {
  minRepetitions: number;
  minStability: number;
  minCharsSaved: number;
  minStepsSaved: number;
  minMultiStepCount: number;
  repetitionMarginScale: number;
  stabilityMarginScale: number;
  charsMarginScale: number;
  stepsMarginScale: number;
  minMarginWeight: number;
  constantDistinctCountMax: number;
  uniqueMinInstances: number;
  uniqueRatioThreshold: number;
};

export const DEFAULT_STATS_CONFIG: StatsDeciderConfig = {
  minRepetitions: 2,
  minStability: 0.7,
  minCharsSaved: 40,
  minStepsSaved: 3,
  minMultiStepCount: 2,
  repetitionMarginScale: 3,
  stabilityMarginScale: 0.25,
  charsMarginScale: 120,
  stepsMarginScale: 12,
  minMarginWeight: 0.5,
  constantDistinctCountMax: 1,
  uniqueMinInstances: 2,
  uniqueRatioThreshold: 1,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizedMargin(distance: number, scale: number): number {
  const safeScale = scale > 0 ? scale : Number.EPSILON;
  return clamp01(distance / safeScale);
}

function blendMargins(margins: number[], minWeight: number): number {
  if (margins.length === 0) return 0;
  const weight = clamp01(minWeight);
  let minVal = margins[0];
  let sum = 0;
  for (const m of margins) {
    if (m < minVal) minVal = m;
    sum += m;
  }
  const meanVal = sum / margins.length;
  return clamp01(weight * minVal + (1 - weight) * meanVal);
}

function isTextSnippetWorkflow(workflow: Workflow): boolean {
  if (workflow.steps.length !== 1) return false;
  const step: Step = workflow.steps[0];
  return step.action === "fill" || step.action === "paste";
}

function getSnippetCharLength(workflow: Workflow): number {
  const step = workflow.steps[0];
  if (!step) return 0;
  if (typeof step.value === "string") {
    return step.value.length;
  }
  if (step.value && typeof step.value === "object") {
    const paramName = step.value.param;
    let totalLength = 0;
    let count = 0;
    for (const instance of workflow.instances) {
      const bound = instance.bindings[paramName];
      if (typeof bound === "string") {
        totalLength += bound.length;
        count += 1;
      }
    }
    if (count > 0) {
      return totalLength / count;
    }
    const paramDef = workflow.params.find((p) => p.name === paramName);
    if (paramDef) {
      return paramDef.example.length;
    }
  }
  return 0;
}

function computeFeatures(
  c: Candidate,
  config: StatsDeciderConfig,
): Record<string, number> {
  const { workflow, repetitions, stability } = c;
  const stepCount = workflow.steps.length;
  const paramCount = workflow.params.length;
  const instanceCount = workflow.instances.length;

  const features: Record<string, number> = {
    repetitions,
    stability,
    stepCount,
    paramCount,
  };

  let ratioSum = 0;
  let constantCount = 0;
  let varyingCount = 0;
  let uniqueCount = 0;

  for (const param of workflow.params) {
    const distinctValues = new Set<string>();
    for (const instance of workflow.instances) {
      const bound = instance.bindings[param.name];
      if (bound !== undefined) {
        distinctValues.add(bound);
      }
    }

    const ratio = instanceCount === 0 ? 0 : distinctValues.size / instanceCount;
    features[`paramDistinctRatio_${param.name}`] = ratio;
    ratioSum += ratio;

    if (instanceCount > 0) {
      if (distinctValues.size <= config.constantDistinctCountMax) {
        constantCount += 1;
      } else {
        varyingCount += 1;
      }

      if (
        instanceCount >= config.uniqueMinInstances &&
        ratio >= config.uniqueRatioThreshold
      ) {
        uniqueCount += 1;
      }
    }
  }

  features.paramDistinctRatioMean = paramCount === 0 ? 0 : ratioSum / paramCount;
  features.paramConstantShare =
    paramCount === 0 || instanceCount === 0 ? 0 : constantCount / paramCount;
  features.paramVaryingShare =
    paramCount === 0 || instanceCount === 0 ? 0 : varyingCount / paramCount;
  features.paramUniqueShare =
    paramCount === 0 || instanceCount === 0 ? 0 : uniqueCount / paramCount;

  return features;
}

export function decideStats(
  c: Candidate,
  config: StatsDeciderConfig = DEFAULT_STATS_CONFIG,
): StatsDecision {
  const features = computeFeatures(c, config);
  const { repetitions, stability, workflow } = c;

  const repFailed = repetitions < config.minRepetitions;
  const stabilityFailed = stability < config.minStability;

  if (repFailed || stabilityFailed) {
    const failMargins: number[] = [];
    if (repFailed) {
      failMargins.push(
        normalizedMargin(
          config.minRepetitions - repetitions,
          config.repetitionMarginScale,
        ),
      );
    }
    if (stabilityFailed) {
      failMargins.push(
        normalizedMargin(
          config.minStability - stability,
          config.stabilityMarginScale,
        ),
      );
    }
    return {
      verdict: "do_not_automate",
      confidence: clamp01(Math.max(...failMargins)),
      features,
    };
  }

  const repMargin = normalizedMargin(
    repetitions - config.minRepetitions,
    config.repetitionMarginScale,
  );
  const stabilityMargin = normalizedMargin(
    stability - config.minStability,
    config.stabilityMarginScale,
  );

  if (isTextSnippetWorkflow(workflow)) {
    const charsSaved = repetitions * getSnippetCharLength(workflow);
    if (charsSaved < config.minCharsSaved) {
      const charsFailMargin = normalizedMargin(
        config.minCharsSaved - charsSaved,
        config.charsMarginScale,
      );
      return {
        verdict: "rung0",
        confidence: blendMargins(
          [charsFailMargin, repMargin, stabilityMargin],
          config.minMarginWeight,
        ),
        features,
      };
    }

    const charsPassMargin = normalizedMargin(
      charsSaved - config.minCharsSaved,
      config.charsMarginScale,
    );
    return {
      verdict: "rung1",
      confidence: blendMargins(
        [repMargin, stabilityMargin, charsPassMargin],
        config.minMarginWeight,
      ),
      features,
    };
  }

  const stepCount = workflow.steps.length;
  const stepsSaved = repetitions * stepCount;

  if (stepCount < config.minMultiStepCount) {
    const stepsFailMargin = normalizedMargin(
      Math.max(0, config.minStepsSaved - stepsSaved),
      config.stepsMarginScale,
    );
    return {
      verdict: "rung0",
      confidence: blendMargins(
        [stepsFailMargin, repMargin, stabilityMargin],
        config.minMarginWeight,
      ),
      features,
    };
  }

  if (stepsSaved < config.minStepsSaved) {
    const stepsFailMargin = normalizedMargin(
      config.minStepsSaved - stepsSaved,
      config.stepsMarginScale,
    );
    return {
      verdict: "rung0",
      confidence: blendMargins(
        [stepsFailMargin, repMargin, stabilityMargin],
        config.minMarginWeight,
      ),
      features,
    };
  }

  const stepsPassMargin = normalizedMargin(
    stepsSaved - config.minStepsSaved,
    config.stepsMarginScale,
  );
  return {
    verdict: "rung2",
    confidence: blendMargins(
      [repMargin, stabilityMargin, stepsPassMargin],
      config.minMarginWeight,
    ),
    features,
  };
}
