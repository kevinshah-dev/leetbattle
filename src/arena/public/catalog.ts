import type {
  AiMlAnswerConstraints,
  AiMlDifficulty,
  PublicAiMlQuestion,
} from "../types";

export const AI_ML_ANSWER_CONSTRAINTS = Object.freeze({
  maxWords: 500,
  maxCharacters: 12_000,
  maxUtf8Bytes: 24_000,
} as const satisfies AiMlAnswerConstraints);

export const PUBLIC_AI_ML_QUESTIONS = Object.freeze([
  {
    id: "mlai-fde-e01",
    version: 1,
    title: "Training, Validation, and Test Sets",
    difficulty: "EASY",
    category: "ML fundamentals",
    tags: ["dataset-splits", "evaluation", "generalization"],
    prompt:
      "Explain the purpose of training, validation, and test datasets. Why should the test set remain untouched until final evaluation?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e02",
    version: 1,
    title: "Underfitting and Overfitting",
    difficulty: "EASY",
    category: "ML fundamentals",
    tags: ["generalization", "model-capacity", "learning-curves"],
    prompt:
      "Describe underfitting and overfitting, how each usually appears in training versus validation performance, and common ways to address them.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e03",
    version: 1,
    title: "How a Neural Network Learns",
    difficulty: "EASY",
    category: "Deep learning",
    tags: ["neural-networks", "backpropagation", "optimization"],
    prompt:
      "In words rather than equations, explain how a neural network learns through a forward pass, a loss function, backpropagation, and an optimizer.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e04",
    version: 1,
    title: "Embeddings and Semantic Search",
    difficulty: "EASY",
    category: "LLMs and retrieval",
    tags: ["embeddings", "semantic-search", "vector-similarity"],
    prompt:
      "What is an embedding, and why can embeddings be used for semantic search? What is one important limitation?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e05",
    version: 1,
    title: "RAG Versus Fine-Tuning",
    difficulty: "EASY",
    category: "LLMs and RAG",
    tags: ["rag", "fine-tuning", "knowledge"],
    prompt:
      "Compare retrieval-augmented generation and fine-tuning. When is each approach a better fit?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e06",
    version: 1,
    title: "Hallucinations and Grounding",
    difficulty: "EASY",
    category: "LLMs and safety",
    tags: ["hallucinations", "grounding", "reliability"],
    prompt:
      "What is an LLM hallucination, why can it occur, and what techniques can reduce its impact?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-e07",
    version: 1,
    title: "Data Drift and Concept Drift",
    difficulty: "EASY",
    category: "Production ML",
    tags: ["data-drift", "concept-drift", "monitoring"],
    prompt:
      "Explain the difference between data drift and concept drift. What should a production ML system monitor to detect resulting problems?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m01",
    version: 1,
    title: "Data Leakage in ML Pipelines",
    difficulty: "MEDIUM",
    category: "ML fundamentals",
    tags: ["data-leakage", "pipeline-design", "evaluation"],
    prompt:
      "Explain data leakage, including two ways it can occur without directly placing the target label in the input. Why does it produce misleading evaluation results, and how can it be prevented?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m02",
    version: 1,
    title: "Evaluating an Imbalanced Classifier",
    difficulty: "MEDIUM",
    category: "ML fundamentals",
    tags: ["class-imbalance", "metrics", "thresholding"],
    prompt:
      "Why can accuracy be misleading on an imbalanced classification task? Describe how you would choose evaluation metrics and improve the system without corrupting the test result.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m03",
    version: 1,
    title: "Self-Attention in Transformers",
    difficulty: "MEDIUM",
    category: "Deep learning",
    tags: ["transformers", "self-attention", "position"],
    prompt:
      "Conceptually explain how self-attention lets a transformer build context-aware token representations. Why is positional information needed, and what is one limitation of attention?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m04",
    version: 1,
    title: "Training and Inference Modes",
    difficulty: "MEDIUM",
    category: "Deep learning",
    tags: ["dropout", "batch-normalization", "inference"],
    prompt:
      "Why must layers such as dropout and batch normalization behave differently during training and inference? What problems can an incorrect mode cause?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m05",
    version: 1,
    title: "Designing a RAG Retrieval Pipeline",
    difficulty: "MEDIUM",
    category: "RAG",
    tags: ["chunking", "retrieval", "reranking"],
    prompt:
      "Explain how chunk size, overlap, metadata filtering, and reranking affect a RAG system. How would you tell whether failures come from retrieval or generation?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m06",
    version: 1,
    title: "Building an LLM Evaluation Suite",
    difficulty: "MEDIUM",
    category: "LLM evaluation",
    tags: ["evaluation", "model-graders", "regression-testing"],
    prompt:
      "Describe a robust evaluation suite for an LLM application. Why is a single aggregate accuracy or model-judge score insufficient?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-m07",
    version: 1,
    title: "Latency, Throughput, and Cost in Inference",
    difficulty: "MEDIUM",
    category: "Production AI",
    tags: ["latency", "throughput", "cost", "reliability"],
    prompt:
      "Explain several techniques for improving model-serving latency, throughput, or cost, along with the tradeoff each introduces. Include at least one reliability consideration.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h01",
    version: 1,
    title: "When Offline Gains Fail Online",
    difficulty: "HARD",
    category: "Production ML",
    tags: ["offline-evaluation", "experimentation", "feedback-loops"],
    prompt:
      "A new model performs substantially better in offline evaluation but shows no improvement after deployment. Explain plausible technical causes and how you would investigate them, including the role of feedback loops.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h02",
    version: 1,
    title: "Hybrid Retrieval and Reranking",
    difficulty: "HARD",
    category: "RAG",
    tags: ["sparse-retrieval", "dense-retrieval", "reranking"],
    prompt:
      "Compare sparse keyword retrieval, dense vector retrieval, and reranking. Explain how a hybrid system can improve quality and what tradeoffs it introduces.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h03",
    version: 1,
    title: "Validating an LLM-as-Judge",
    difficulty: "HARD",
    category: "LLM evaluation",
    tags: ["llm-as-judge", "bias", "validation"],
    prompt:
      "What biases and failure modes can affect an LLM used to score free-form answers, and how would you validate and harden that judge?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h04",
    version: 1,
    title: "Fine-Tuning Without Losing General Capability",
    difficulty: "HARD",
    category: "Deep learning",
    tags: ["fine-tuning", "catastrophic-forgetting", "model-evaluation"],
    prompt:
      "Why can fine-tuning improve a specialized task while degrading a model’s other abilities? Describe strategies for reducing that risk and proving that the adapted model is actually better.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h05",
    version: 1,
    title: "Safe Model Rollouts and Rollbacks",
    difficulty: "HARD",
    category: "Production AI",
    tags: ["deployment", "canary", "rollback", "compatibility"],
    prompt:
      "Design a safe rollout strategy for a new model version whose outputs feed other services. Address compatibility, observability, gradual exposure, and rollback.",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
  {
    id: "mlai-fde-h06",
    version: 1,
    title: "Calibration, Uncertainty, and Abstention",
    difficulty: "HARD",
    category: "ML fundamentals and Production AI",
    tags: ["calibration", "uncertainty", "abstention"],
    prompt:
      "Explain what it means for a predictive system to be calibrated. How can uncertainty estimates and abstention make a system safer, and why is an LLM’s stated confidence not automatically trustworthy?",
    answerConstraints: AI_ML_ANSWER_CONSTRAINTS,
  },
] as const satisfies readonly PublicAiMlQuestion[]);

export function listPublicAiMlQuestionsByDifficulty(
  difficulty: AiMlDifficulty,
): readonly PublicAiMlQuestion[] {
  return PUBLIC_AI_ML_QUESTIONS.filter(
    (question) => question.difficulty === difficulty,
  );
}

export function getPublicAiMlQuestion(
  id: string,
  version?: number,
): PublicAiMlQuestion | undefined {
  return PUBLIC_AI_ML_QUESTIONS.find(
    (question) =>
      question.id === id &&
      (version === undefined || question.version === version),
  );
}
