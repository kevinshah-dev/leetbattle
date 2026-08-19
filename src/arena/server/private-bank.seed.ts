/**
 * Seed-only trusted material. Application and Worker runtime entry points must
 * load private rubric data from PostgreSQL and must never import this module.
 */
import { PUBLIC_AI_ML_QUESTIONS } from "../public/catalog";
import type {
  AiMlRubricCriterion,
  PrivateAiMlQuestion,
  PublicAiMlQuestion,
} from "../types";

function requiredPublic(id: string): PublicAiMlQuestion {
  const question = PUBLIC_AI_ML_QUESTIONS.find(
    (candidate) => candidate.id === id,
  );
  if (!question) throw new Error(`Missing public AI/ML question ${id}`);
  return question;
}

function criteria(
  technicalCorrectness: string,
  relevantCompleteness: string,
  technicalDepth: string,
  clarity: string,
): readonly AiMlRubricCriterion[] {
  return Object.freeze([
    {
      id: "technical_correctness",
      label: "Technical correctness",
      description: technicalCorrectness,
      weight: 45,
    },
    {
      id: "relevant_completeness",
      label: "Relevant completeness",
      description: relevantCompleteness,
      weight: 25,
    },
    {
      id: "technical_depth",
      label: "Technical depth and tradeoffs",
      description: technicalDepth,
      weight: 20,
    },
    {
      id: "clarity",
      label: "Clarity and directness",
      description: clarity,
      weight: 10,
    },
  ]);
}

export const PRIVATE_AI_ML_QUESTION_BANK = Object.freeze([
  {
    public: requiredPublic("mlai-fde-e01"),
    referenceAnswerNotes:
      "Training fits model parameters; validation guides model selection, hyperparameters, and early stopping; testing estimates generalization on unseen data. Repeated test consultation indirectly optimizes against it and creates an optimistic result.",
    requiredConcepts: [
      "Training data fits learned model parameters.",
      "Validation data guides model or hyperparameter choices and early stopping.",
      "Test data estimates final generalization on unseen data.",
      "Repeated test consultation leaks selection decisions and biases the estimate upward.",
    ],
    optionalNuances: [
      "Cross-validation",
      "Representative or stratified splits",
      "Nested validation",
    ],
    seriousErrors: [
      "Treating validation and test as interchangeable",
      "Using test data for tuning",
      "Claiming repeated test use stays unbiased",
    ],
    criteria: criteria(
      "Correctly distinguishes parameter fitting, validation-driven selection, and final unseen-data evaluation, including why repeated test access biases the estimate.",
      "Covers the role of all three splits and the consequence of test-set contamination without substituting one split for another.",
      "Explains the causal path from repeated test consultation to indirect optimization and may discuss representative splits or cross-validation appropriately.",
      "Presents the three dataset roles and the test-set rule in a concise, unambiguous progression.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e02"),
    referenceAnswerNotes:
      "Underfitting performs poorly on training and validation because the model has not captured the pattern. Overfitting performs well on training but poorly on unseen data. Appropriate remedies must be given for each.",
    requiredConcepts: [
      "Underfitting produces poor training and validation performance.",
      "Overfitting produces strong training performance but weak validation or unseen-data performance.",
      "Underfitting remedies increase useful capacity, features, training, or reduce excessive regularization.",
      "Overfitting remedies improve data, regularization, validation-based stopping, or reduce capacity.",
    ],
    optionalNuances: [
      "Learning curves",
      "Irreducible noise",
      "Distribution shift",
    ],
    seriousErrors: [
      "Claiming more training always fixes overfitting",
      "Using regularization as the primary fix for underfitting",
      "Treating high training accuracy as proof of quality",
    ],
    criteria: criteria(
      "Accurately identifies the characteristic training-versus-validation patterns for both underfitting and overfitting and gives suitable remedies for each.",
      "Addresses both failure modes, their observable signals, and more than one appropriate corrective action without conflating them.",
      "Connects remedies to model capacity, optimization, data, or regularization and recognizes complications such as noise or distribution shift.",
      "Uses a direct side-by-side explanation that makes the contrasting performance patterns easy to distinguish.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e03"),
    referenceAnswerNotes:
      "The forward pass produces predictions; loss measures error; backpropagation calculates how parameters contributed to loss; the optimizer uses gradients to update parameters; repetition over batches improves the objective.",
    requiredConcepts: [
      "A forward pass converts inputs into predictions.",
      "A loss function quantifies prediction error or objective quality.",
      "Backpropagation computes gradients that attribute loss sensitivity to parameters.",
      "An optimizer uses gradients to update parameters across repeated batches.",
    ],
    optionalNuances: [
      "Learning rate",
      "Mini-batches",
      "Validation-based stopping",
    ],
    seriousErrors: [
      "Saying backpropagation itself updates weights",
      "Saying the optimizer calculates the loss",
      "Claiming training must reach zero loss",
    ],
    criteria: criteria(
      "Correctly orders and assigns responsibility to the forward pass, loss, backpropagation, and optimizer without claiming backpropagation performs the update.",
      "Explains every named stage and the repeated batch-training loop that improves the objective.",
      "Provides a causal account of gradients and parameter updates and may accurately discuss learning rate, mini-batches, or stopping on validation behavior.",
      "Explains the learning loop in plain language, with distinct roles for each component and no unnecessary equations.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e04"),
    referenceAnswerNotes:
      "An embedding is a learned dense vector representation. Related inputs can be close under vector similarity, enabling semantic retrieval without exact keyword matches. Similarity reflects the model and training objective and does not guarantee truth or relevance.",
    requiredConcepts: [
      "An embedding is a learned dense vector representation.",
      "Vector proximity can encode semantic relatedness.",
      "Similarity search can retrieve related meaning without exact keyword overlap.",
      "Similarity is model-dependent and does not guarantee factual truth or task relevance.",
    ],
    optionalNuances: [
      "Domain-specific embeddings",
      "Normalization",
      "Reranking",
      "Contextual ambiguity",
    ],
    seriousErrors: [
      "Claiming embeddings store exact definitions",
      "Claiming nearby vectors guarantee factual agreement",
      "Claiming one model works equally well in every domain",
    ],
    criteria: criteria(
      "Defines embeddings as learned dense vectors, explains semantic similarity retrieval, and states a real limitation without equating proximity with truth.",
      "Covers representation, similarity-based retrieval, the advantage over exact matching, and at least one consequential limitation.",
      "Explains how model objectives and domain fit shape the vector space and may discuss normalization, reranking, or ambiguity as mitigations and tradeoffs.",
      "Connects the definition, search mechanism, and limitation in a compact explanation using precise terminology.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e05"),
    referenceAnswerNotes:
      "RAG retrieves external information at inference and suits changing, private, or sourceable knowledge, but depends on retrieval quality and context. Fine-tuning changes model weights and suits stable behavior, style, format, or repeated tasks, but is not a reliable factual database. They may be combined.",
    requiredConcepts: [
      "RAG retrieves external context at inference time.",
      "RAG fits changing, private, or sourceable knowledge and depends on retrieval quality.",
      "Fine-tuning changes model weights to adapt stable behavior, style, format, or repeated tasks.",
      "Fine-tuning is not a reliable current-fact database, and both approaches can be combined.",
    ],
    optionalNuances: [
      "Prompting as a cheaper baseline",
      "Citations",
      "Parameter-efficient tuning",
    ],
    seriousErrors: [
      "Saying RAG trains the base model",
      "Saying fine-tuning automatically keeps facts current",
      "Saying fine-tuning guarantees factuality",
    ],
    criteria: criteria(
      "Accurately distinguishes inference-time retrieval from weight adaptation and assigns appropriate use cases and limitations to each.",
      "Covers when RAG is preferable, when fine-tuning is preferable, their major dependencies or risks, and the possibility of combining them.",
      "Explains the knowledge-versus-behavior tradeoff, retrieval/context failure modes, and may position prompting or parameter-efficient tuning as alternatives.",
      "Makes the comparison explicit and decision-oriented without implying either technique guarantees factuality.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e06"),
    referenceAnswerNotes:
      "A hallucination is fluent but unsupported or incorrect output. Models predict plausible tokens rather than consult an inherent source of truth. Grounding, citations, abstention, constrained tools, validation, and evaluation can reduce but not eliminate the risk.",
    requiredConcepts: [
      "A hallucination is fluent output that is unsupported or incorrect.",
      "Language models generate plausible token sequences rather than consult an inherent truth source.",
      "Grounding, citations, abstention, constrained tools, validation, and evaluation reduce impact.",
      "Mitigations reduce but do not eliminate hallucination risk.",
    ],
    optionalNuances: [
      "Retrieval can supply bad evidence",
      "Temperature changes variability but is not the root cause",
    ],
    seriousErrors: [
      "Calling hallucination intentional deception",
      "Saying temperature zero eliminates hallucination",
      "Saying RAG guarantees truth",
    ],
    criteria: criteria(
      "Correctly defines hallucination, relates it to probabilistic generation rather than deception, and gives valid mitigations without guarantees.",
      "Addresses what hallucination is, why it occurs, and several distinct impact-reduction techniques.",
      "Explains the limitations of grounding and retrieval and distinguishes variability controls from factual verification.",
      "Uses concrete mitigation categories and clearly states residual risk without vague claims about model intent.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-e07"),
    referenceAnswerNotes:
      "Data drift changes the input distribution; concept drift changes the relationship between inputs and outcomes. Monitor distributions, slice-level quality when labels arrive, calibration/confidence signals, latency, and errors.",
    requiredConcepts: [
      "Data drift is a change in the input distribution.",
      "Concept drift is a change in the relationship between inputs and outcomes.",
      "Production monitoring should include distributions and slice-level predictive quality when labels arrive.",
      "Calibration or confidence, latency, and errors complement quality monitoring.",
    ],
    optionalNuances: [
      "Label shift",
      "Alert baselines",
      "Drift without performance loss",
    ],
    seriousErrors: [
      "Saying all drift requires retraining",
      "Saying stable inputs guarantee stable accuracy",
      "Saying infrastructure metrics alone are sufficient",
    ],
    criteria: criteria(
      "Correctly distinguishes input-distribution change from input-to-outcome relationship change and identifies monitoring that can reveal performance impact.",
      "Includes distribution monitoring, labeled slice quality, and operational or confidence signals rather than relying on infrastructure metrics alone.",
      "Recognizes delayed labels, baselines, label shift, or the fact that detectable drift need not imply harmful quality loss.",
      "States both drift definitions and the monitoring plan with concrete, non-overlapping examples.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m01"),
    referenceAnswerNotes:
      "Leakage exposes training to information unavailable at inference. Valid examples include preprocessing fitted on all data, future-derived features, duplicate entities across splits, or improper entity/time splits. It creates optimistic evaluation and is prevented with leakage-safe transforms and splitting discipline.",
    requiredConcepts: [
      "Leakage exposes model development to information unavailable at real inference time.",
      "At least two indirect leakage mechanisms, such as global preprocessing, future features, duplicates, or bad entity/time splits.",
      "Leakage creates an unrealistically optimistic evaluation.",
      "Prevention requires split-first, leakage-safe transformations and entity/time-aware discipline.",
    ],
    optionalNuances: [
      "Target leakage versus contamination",
      "Point-in-time joins",
    ],
    seriousErrors: [
      "Saying leakage only means including the label column",
      "Saying random splitting is always safe",
    ],
    criteria: criteria(
      "Defines leakage by inference-time availability, gives at least two valid non-label examples, and explains why evaluation becomes optimistic.",
      "Covers mechanisms, evaluation impact, and prevention through correct transform fitting and split design.",
      "Explains temporal or entity dependencies, contamination pathways, or point-in-time correctness rather than listing examples without causality.",
      "Organizes the answer around definition, examples, consequence, and prevention with technically precise examples.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m02"),
    referenceAnswerNotes:
      "Majority prediction can produce high accuracy while missing the rare class. Metrics must reflect false-positive/false-negative costs, such as precision, recall, F-score, PR curves, and slice metrics. Interventions may include class weighting, training-only resampling, improved data, or threshold selection. Test data stays untouched and representative.",
    requiredConcepts: [
      "Majority-class prediction can have high accuracy while failing on the rare class.",
      "Metric choice must reflect false-positive and false-negative costs.",
      "Useful metrics include precision, recall, F-score, PR curves, and slice-level results.",
      "Interventions use training or validation data while the representative test set remains untouched.",
    ],
    optionalNuances: [
      "Calibration",
      "Prevalence changes",
      "ROC-AUC versus PR-AUC",
    ],
    seriousErrors: [
      "Balancing the test set to improve the metric",
      "Oversampling before splitting",
      "Claiming one metric is universally best",
    ],
    criteria: criteria(
      "Explains the majority-class accuracy trap, selects cost-appropriate metrics, and keeps resampling or threshold tuning out of the final test set.",
      "Includes multiple relevant metrics, concrete improvement options, and representative untouched testing.",
      "Connects thresholds, prevalence, calibration, PR behavior, and asymmetric error costs to the system objective.",
      "Frames metric and intervention choices around the application’s error costs instead of presenting an undifferentiated metric list.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m03"),
    referenceAnswerNotes:
      "Query/key compatibility controls weighted combination of value representations; multiple heads may learn different relationships. Attention alone does not encode sequence order, so positional information is needed. Include a real limitation such as context-length cost.",
    requiredConcepts: [
      "Queries and keys determine compatibility or attention weights.",
      "Weights combine value representations into context-aware token representations.",
      "Multiple heads can capture different relationships.",
      "Positional information supplies order, and attention has a real limitation such as context-length cost.",
    ],
    optionalNuances: [
      "Causal masks",
      "Sparse or local attention",
      "Multi-head specialization",
    ],
    seriousErrors: [
      "Saying attention inherently knows order",
      "Saying attention weights are definitive explanations",
      "Saying attending to a fact guarantees correctness",
    ],
    criteria: criteria(
      "Correctly explains query/key compatibility, weighted value aggregation, the need for position, and a genuine limitation of attention.",
      "Covers context-aware representations, multi-head behavior, positional information, and at least one limitation.",
      "Explains why order is absent from bare attention and may accurately discuss masks, sparse attention, or quadratic context cost.",
      "Describes the mechanism conceptually without hiding the roles of queries, keys, values, or position behind vague anthropomorphic language.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m04"),
    referenceAnswerNotes:
      "Dropout randomly suppresses activations during training and is normally disabled for inference. Batch normalization uses batch statistics during training and stored running statistics for inference. Incorrect mode causes unstable, nondeterministic, or shifted predictions.",
    requiredConcepts: [
      "Dropout randomly suppresses activations during training.",
      "Dropout is normally disabled during inference.",
      "Batch normalization uses batch statistics in training and stored running statistics in inference.",
      "Wrong mode can produce nondeterministic, unstable, or distribution-shifted predictions.",
    ],
    optionalNuances: [
      "Layer normalization differences",
      "Monte Carlo dropout as an intentional exception",
    ],
    seriousErrors: [
      "Saying dropout stays active in normal inference",
      "Saying batch normalization is only regularization",
      "Saying train/eval mode cannot affect output",
    ],
    criteria: criteria(
      "Accurately describes the distinct train/eval behavior of dropout and batch normalization and the prediction failures caused by a wrong mode.",
      "Covers both layer types, their training and inference behavior, and multiple observable consequences.",
      "Explains why stochastic masking and batch-dependent statistics require mode changes and may identify valid intentional exceptions.",
      "Keeps dropout and batch-normalization mechanisms distinct and directly links each to inference behavior.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m05"),
    referenceAnswerNotes:
      "Explain small-versus-large chunk tradeoffs, overlap’s boundary and duplication tradeoff, filtering’s narrowing role, reranking’s ordering role, and separate retrieval relevance/recall from answer correctness/faithfulness.",
    requiredConcepts: [
      "Chunk size trades focused retrieval against sufficient context.",
      "Overlap can preserve boundary context but increases duplication and cost.",
      "Metadata filters narrow eligible material, while reranking reorders retrieved candidates.",
      "Retrieval relevance or recall must be evaluated separately from generation correctness and faithfulness.",
    ],
    optionalNuances: [
      "Query rewriting",
      "Parent-child retrieval",
      "Context packing",
      "Deduplication",
    ],
    seriousErrors: [
      "Saying more overlap or more chunks is always better",
      "Saying prompting recovers missing evidence",
      "Saying end-to-end accuracy alone identifies the failing stage",
    ],
    criteria: criteria(
      "Correctly explains chunking, overlap, filtering, reranking, and a diagnostic separation between retrieval and generation failures.",
      "Addresses every named pipeline control and gives stage-specific evaluation signals for both retrieval and generation.",
      "Explains precision, recall, duplication, context-window, and latency tradeoffs and may discuss query rewriting or context packing.",
      "Uses a clear pipeline sequence and distinguishes candidate eligibility, ordering, and answer generation.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m06"),
    referenceAnswerNotes:
      "Use a versioned representative dataset and important slices; measure correctness, relevance, groundedness, safety, latency, and cost; combine deterministic checks, calibrated model graders, and human review; include adversarial and regression cases.",
    requiredConcepts: [
      "A versioned representative evaluation dataset with important slices.",
      "Metrics spanning correctness, relevance, groundedness, safety, latency, and cost.",
      "A combination of deterministic checks, calibrated model graders, and human review.",
      "Adversarial and regression cases plus slice-level analysis beyond one aggregate score.",
    ],
    optionalNuances: [
      "Inter-rater agreement",
      "Confidence intervals",
      "Online experiments",
      "Contamination control",
    ],
    seriousErrors: [
      "Claiming one benchmark proves production quality",
      "Treating an LLM judge as ground truth",
      "Assuming average improvement helps every slice",
    ],
    criteria: criteria(
      "Designs a versioned, representative, multi-metric suite that triangulates deterministic, model, and human evaluation without treating a grader as ground truth.",
      "Includes key quality, safety, operational, adversarial, regression, and slice dimensions.",
      "Explains grader calibration, human agreement, uncertainty, contamination, or online validation and why aggregate results can hide regressions.",
      "Presents a coherent evaluation program with clearly separated datasets, metrics, graders, and decision criteria.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-m07"),
    referenceAnswerNotes:
      "Distinguish latency from throughput and explain at least three techniques with real tradeoffs, such as batching, caching, quantization, smaller-model routing, autoscaling, or warm capacity. Include timeouts, bounded retries, circuit breakers, fallbacks, or tail-latency monitoring.",
    requiredConcepts: [
      "Latency and throughput are distinct serving objectives.",
      "At least three valid optimization techniques are explained with genuine tradeoffs.",
      "Techniques may include batching, caching, quantization, model routing, autoscaling, or warm capacity.",
      "At least one reliability control such as timeouts, bounded retries, circuit breakers, fallbacks, or tail-latency monitoring.",
    ],
    optionalNuances: [
      "Streaming",
      "Admission control",
      "Prioritization",
      "Compilation",
    ],
    seriousErrors: [
      "Saying maximum batching minimizes every request’s latency",
      "Saying retries are free",
      "Saying average latency is sufficient",
    ],
    criteria: criteria(
      "Distinguishes latency from throughput, accurately explains at least three optimizations and their tradeoffs, and includes a valid reliability consideration.",
      "Covers multiple serving levers across compute, scheduling, caching, capacity, or routing rather than repeating one technique.",
      "Reasons about tail latency, queueing, quality, memory, staleness, retry amplification, and capacity tradeoffs.",
      "Pairs each technique with its consequence and keeps reliability controls explicit and operationally concrete.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h01"),
    referenceAnswerNotes:
      "Cover plausible data, metric, integration, and serving causes such as train-serving skew, leakage, shift, bad logging, proxy mismatch, delayed labels, or selection effects. Explain how deployment changes future observed data and provide a concrete investigation plan using replay, slices, shadow/canary traffic, and controlled experiments.",
    requiredConcepts: [
      "Plausible causes span data, metrics, integration, and serving behavior.",
      "Examples include train-serving skew, leakage, distribution shift, logging defects, proxy mismatch, delayed labels, or selection effects.",
      "Deployment can change future observed data through feedback loops.",
      "Investigation uses replay, slice analysis, shadow or canary traffic, and controlled experiments.",
    ],
    optionalNuances: [
      "Exploration data",
      "Causal inference",
      "Treatment interference",
    ],
    seriousErrors: [
      "Saying offline gains guarantee online gains",
      "Saying retraining automatically fixes feedback loops",
      "Saying logged correlation proves impact",
    ],
    criteria: criteria(
      "Identifies technically plausible offline-to-online failure modes across layers and correctly explains feedback loops without inferring causality from logged correlation.",
      "Provides a concrete investigation plan covering data, model, integration, serving, metrics, and controlled online evidence.",
      "Explains selection effects and how deployed decisions alter later training or evaluation data, with appropriate replay, shadow, canary, or experiment tradeoffs.",
      "Structures hypotheses and tests so each proposed cause has an observable diagnostic rather than offering an unprioritized list.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h02"),
    referenceAnswerNotes:
      "Sparse retrieval handles exact terms and rare identifiers; dense retrieval handles semantic similarity; hybrid retrieval fuses candidate sets/ranks; expensive reranking operates on a limited candidate set. Explain quality, latency, compute, and complexity tradeoffs.",
    requiredConcepts: [
      "Sparse retrieval is strong for exact terms and rare identifiers.",
      "Dense retrieval is strong for semantic similarity.",
      "Hybrid retrieval fuses candidate sets or ranks.",
      "A more expensive reranker scores a limited candidate set, introducing quality, latency, compute, and complexity tradeoffs.",
    ],
    optionalNuances: [
      "Reciprocal-rank fusion",
      "Access filters",
      "Stage-specific metrics",
    ],
    seriousErrors: [
      "Saying vector retrieval makes lexical search obsolete",
      "Saying reranking the entire corpus is normally practical",
      "Saying reranking recovers excluded documents",
    ],
    criteria: criteria(
      "Correctly characterizes sparse, dense, fusion, and limited-candidate reranking roles without claiming reranking can recover absent documents.",
      "Explains how the stages combine, where each contributes quality, and the principal operational tradeoffs.",
      "Reasons about candidate recall, rank fusion, access filtering, stage-specific metrics, compute, and latency.",
      "Describes the staged architecture in order and uses concrete retrieval strengths rather than generic claims of better search.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h03"),
    referenceAnswerNotes:
      "Cover at least three issues such as position, verbosity, style, model-family bias, nondeterminism, prompt injection, or inconsistent rubric use. Include explicit rubrics, anonymization, untrusted-answer delimiting, human-scored calibration, agreement/order-sensitivity/stability measurement, and audits.",
    requiredConcepts: [
      "At least three judge failure modes such as position, verbosity, style, family bias, nondeterminism, injection, or rubric inconsistency.",
      "Explicit rubrics, anonymization, and strong separation of untrusted answer data.",
      "Calibration against blinded human-scored examples.",
      "Agreement, order sensitivity, stability, and ongoing audit measurement.",
    ],
    optionalNuances: [
      "Position-swapped testing",
      "Ensembles",
      "Blinded adjudication",
      "Calibration drift",
    ],
    seriousErrors: [
      "Saying a numeric score is inherently objective",
      "Saying low temperature eliminates systematic bias",
      "Saying a persuasive explanation proves correctness",
    ],
    criteria: criteria(
      "Identifies at least three real LLM-judge biases or failures and proposes rubric, anonymization, injection-resistance, and human-calibration controls.",
      "Includes validation measurements for agreement, order effects, stability, and audits rather than relying on a single score correlation.",
      "Explains experimental designs such as position swaps or blinded adjudication and recognizes systematic bias and calibration drift beyond randomness.",
      "Separates failure modes, hardening controls, and validation evidence in a precise evaluation plan.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h04"),
    referenceAnswerNotes:
      "Explain over-specialization, distribution shift, or catastrophic forgetting. Include at least two mitigations such as representative data, retention-data mixing, conservative optimization, early stopping, regularization, or adapters. Evaluate target and retained general/safety/out-of-domain capabilities against the original.",
    requiredConcepts: [
      "Specialized adaptation can cause over-specialization, distribution shift, or catastrophic forgetting.",
      "At least two credible mitigations, such as representative data, retention mixing, conservative optimization, early stopping, regularization, or adapters.",
      "Evaluation compares target-task gains against the original model.",
      "Evaluation also covers retained general, safety, and out-of-domain capabilities.",
    ],
    optionalNuances: [
      "Adapter isolation and rollback",
      "Preference-tuning tradeoffs",
    ],
    seriousErrors: [
      "Saying parameter-efficient tuning cannot regress behavior",
      "Saying more examples always help",
      "Saying target-task gains alone prove superiority",
    ],
    criteria: criteria(
      "Correctly explains why specialization can regress other behavior, supplies at least two valid mitigations, and requires comparative retained-capability evaluation.",
      "Covers mechanisms, mitigation strategy, target evaluation, and general, safety, and out-of-domain regression testing.",
      "Reasons about optimization strength, data mixture, adapter isolation, rollback, and tradeoffs between specialization and retention.",
      "Connects each mitigation and evaluation slice to a stated regression risk without claiming any technique is regression-proof.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h05"),
    referenceAnswerNotes:
      "Version model artifacts, prompts, features, schemas, and dependencies; use contract tests and backward-compatible handling; perform replay/shadow testing, canary exposure, gradual expansion, quality/safety/latency/error/cost guardrails, and tested rapid rollback.",
    requiredConcepts: [
      "Version model artifacts, prompts, features, schemas, and dependencies together.",
      "Use contract tests and backward-compatible consumers or adapters.",
      "Progress through replay or shadow testing, canary exposure, and gradual expansion.",
      "Monitor quality, safety, latency, errors, and cost with a tested rapid rollback path.",
    ],
    optionalNuances: [
      "Champion-challenger routing",
      "Feature flags",
      "Cache namespace versioning",
      "State migrations",
    ],
    seriousErrors: [
      "Versioning only weights",
      "Monitoring only infrastructure during canary",
      "Assuming rollback is safe without schema or state testing",
    ],
    criteria: criteria(
      "Designs an end-to-end versioned rollout with compatibility validation, staged exposure, multidimensional guardrails, and a genuinely tested rollback.",
      "Addresses artifacts and contracts, preproduction evidence, canary progression, observability, stop conditions, and rollback execution.",
      "Explains state, schema, cache, dependency, and downstream compatibility risks and how feature flags or champion-challenger routing control them.",
      "Presents a sequenced rollout plan with explicit gates, ownership, and rollback triggers.",
    ),
  },
  {
    public: requiredPublic("mlai-fde-h06"),
    referenceAnswerNotes:
      "A calibrated probability corresponds to observed correctness frequency on comparable predictions. Calibration needs representative empirical evaluation and may degrade under shift. Abstention trades coverage for reduced risk. An LLM’s verbal confidence is generated text, not a validated probability.",
    requiredConcepts: [
      "A calibrated probability matches observed correctness frequency among comparable predictions.",
      "Calibration requires representative empirical evaluation and can degrade under distribution shift.",
      "Uncertainty-aware abstention trades coverage for lower selective risk.",
      "An LLM’s verbal confidence is generated text, not automatically a validated probability.",
    ],
    optionalNuances: [
      "Reliability diagrams",
      "Selective risk",
      "Conformal methods",
      "Model disagreement",
    ],
    seriousErrors: [
      "Treating softmax or confident language as automatically calibrated",
      "Equating calibration with accuracy",
      "Claiming abstention has no coverage cost",
    ],
    criteria: criteria(
      "Defines empirical calibration correctly, distinguishes it from accuracy, explains shift sensitivity and abstention tradeoffs, and rejects verbal confidence as automatic probability.",
      "Covers calibration measurement, uncertainty use, safety through abstention, coverage cost, and LLM-confidence limitations.",
      "Explains reliability analysis, selective risk, conformal guarantees or model disagreement with their assumptions and distribution dependence.",
      "Uses a concrete frequency interpretation and clearly separates probability calibration, uncertainty, abstention, and generated confidence language.",
    ),
  },
] as const satisfies readonly PrivateAiMlQuestion[]);
