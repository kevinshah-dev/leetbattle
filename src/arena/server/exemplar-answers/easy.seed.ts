/**
 * Seed-only exemplar material for Easy AI/ML questions. Runtime code must load
 * these answers from PostgreSQL rather than importing this module.
 */
export const EASY_AI_ML_EXEMPLAR_ANSWERS = Object.freeze([
  {
    id: "mlai-fde-e01",
    version: 1,
    answer: `A training set, validation set, and test set serve different stages of model development. Their separation matters because evaluating on data that influenced a model or a development decision does not measure genuinely unseen performance.

The training set is the data used to fit learned parameters. For a neural network, optimization repeatedly examines training examples, computes losses, and changes weights. Other algorithms similarly estimate coefficients, split points, or probabilities from this set. Consequently, training performance mainly describes how well the fitted model handles observations it was allowed to learn from; it is not an unbiased estimate of generalization.

The validation set supports choices surrounding that fitting process without directly updating parameters in the ordinary training step. Developers compare architectures, features, regularization strengths, learning rates, thresholds, and other hyperparameters on validation results. They may also use validation behavior for early stopping or to select one checkpoint among many. Because these choices are optimized using validation feedback, the selected system has indirectly adapted to that set. Validation performance can therefore become optimistic after extensive experimentation, even though its labels never entered gradient updates.

The test set provides a final estimate of performance on unseen data after the entire modeling procedure has been fixed. That procedure includes preprocessing, feature selection, hyperparameters, threshold selection, checkpoint selection, and metric definitions. The test split should remain untouched until then. If developers repeatedly inspect test results and change the system in response, information about test-specific noise influences selection. Trying enough alternatives will eventually reward some accidental fit to that particular sample, so the reported score becomes biased upward and may not reproduce on new production data. Merely avoiding direct training on test rows does not prevent this selection leakage.

All splits should represent the intended deployment population. Classification splits are often stratified; grouped data should keep related entities together; temporal tasks should respect time so future information cannot predict the past. Preprocessing statistics must be fitted on training data and then applied unchanged to validation and test data.

When data is limited, cross-validation can rotate training and validation folds to estimate selection performance more efficiently. The final test set still remains sealed. If both hyperparameter selection and an unbiased performance estimate must occur through resampling, nested cross-validation uses inner folds for selection and outer folds for evaluation.

A disciplined workflow therefore fits on training data, makes every development choice with training and validation evidence, freezes the complete pipeline, evaluates once on the representative test set, and reports that result with uncertainty and relevant slice metrics. If test evidence motivates further changes, that set has effectively become validation data; a fresh independent test set is needed for an honest final estimate.

Reporting should also describe how the splits were sampled, their sizes, uncertainty around the final metric, and any population limitations. In regulated or high-stakes settings, an external holdout collected later can test temporal transportability. After launch, production monitoring addresses new drift; it does not retroactively repair a contaminated test estimate or justify tuning against the original holdout.`,
  },
  {
    id: "mlai-fde-e02",
    version: 1,
    answer: `Underfitting and overfitting are different failures of generalization. Underfitting means the learned model has not captured enough useful structure even in the data available for learning. Overfitting means it has captured training-specific detail, including noise or accidental correlations, that does not transfer to unseen examples.

Underfitting usually appears as poor performance on both training and validation sets. For a loss, both values remain undesirably high; for an accuracy-like metric, both remain low relative to a meaningful baseline. The gap between them may be small because the model performs badly everywhere. Common causes include insufficient model capacity, uninformative features, excessive regularization, inadequate optimization, or stopping too early. Remedies should address that limitation: use more expressive features or a more capable model, train long enough, improve optimization, or reduce regularization that is suppressing useful patterns. Better labels and task formulation may also help. Adding regularization as the primary response generally worsens genuine underfitting.

Overfitting usually appears as strong and continuing improvement on training data while validation performance stalls or deteriorates. A widening training-validation gap is the characteristic signal. The model may have excessive capacity relative to the amount and diversity of data, train too long, exploit leakage, or learn unstable shortcuts. Remedies include collecting more representative data, applying appropriate augmentation, strengthening regularization, reducing capacity, pruning features, and stopping at the checkpoint with best validation behavior. Ensembling can reduce variance, while leakage-safe pipeline design removes falsely predictive information. Simply training longer is not a general cure; it can deepen the fit to noise.

Learning curves make the distinction clearer. If training and validation scores converge at similarly poor levels as data increases, useful capacity or optimization is lacking. If training stays excellent while validation remains substantially worse, variance or mismatch is more likely; additional representative data can narrow that gap. Curves should use the same metric, preprocessing, and untouched examples at each comparison.

These patterns are diagnostic clues, not infallible labels. Irreducible label noise can cap both scores. A distribution shift can produce good training performance and weak validation performance even when model complexity is reasonable. An unrepresentative validation set, duplicate entities across splits, or different measurement quality can imitate either pattern. Metrics must also match the actual objective and be inspected across important slices.

The practical response is iterative and validation-driven: establish baselines, compare training and validation trajectories, inspect errors, propose a cause, change one relevant factor, and reevaluate. Hyperparameters and stopping decisions belong to validation data, while a separate test set is reserved for the final estimate. High training accuracy alone proves only that the model fits its training sample; good validation and final test performance provide the evidence that it generalizes.

Model choice should match the remedy to evidence rather than to a slogan about bias or variance. A simpler model can sometimes outperform a larger one, but only validation results establish that for the task. Likewise, more data helps overfitting only when it is relevant, correctly labeled, and representative; duplicated or shifted examples may add volume without adding information.`,
  },
  {
    id: "mlai-fde-e03",
    version: 1,
    answer: `A neural network learns by repeating a feedback loop that connects its predictions to small, purposeful changes in its parameters. Before training, its weights are initialized, usually to small random values. Those weights determine how strongly signals move through the network, but initially they do not encode a useful solution.

During the forward pass, a batch of input examples enters the first layer. Each layer transforms the representations produced by the preceding layer using its current weights, biases, and activation functions. Information flows forward until the output layer produces predictions, such as class probabilities or a numerical estimate. The forward pass only computes what the current network predicts; it does not by itself decide how the parameters should change.

A loss function then compares those predictions with the desired targets and reduces the mismatch to an objective value. The loss must suit the task: classification and regression generally use different losses, for example. A lower value means better performance under that objective, although low training loss alone does not guarantee useful generalization. Regularization terms may be included to discourage undesirable parameter values or overly complex solutions.

Backpropagation determines how sensitive the loss is to every trainable parameter. Starting from the loss, it applies the chain rule backward through the operations recorded during the forward pass. The resulting gradient for a weight indicates the direction and local rate in which changing that weight would change the loss. Backpropagation computes these gradients efficiently; it does not itself update the weights.

The optimizer performs the update. Algorithms such as stochastic gradient descent or Adam use the gradients, and sometimes running statistics about earlier gradients, to choose parameter changes intended to reduce future loss. The learning rate controls update size. A rate that is too large can overshoot or destabilize training, while one that is too small can make progress extremely slow. After the optimizer updates parameters, the next forward pass reflects the revised network.

Training repeats this sequence over many mini-batches: forward pass, loss calculation, backpropagation, optimizer step. Mini-batches provide affordable, somewhat noisy estimates of the direction that would improve performance over the full training set. One pass through the training data is an epoch. Batches are commonly shuffled between epochs, and gradients are cleared before the next update so they do not accumulate unintentionally.

Separate validation data checks whether improvement transfers beyond training examples. Developers may save checkpoints and stop when validation performance ceases improving, even if training loss continues falling, because continued optimization can overfit. They may also adjust architecture, learning-rate schedules, regularization, or data quality using validation evidence.

Learning therefore does not require reaching zero loss, which may be impossible or undesirable with noisy data. Its goal is parameters that minimize an appropriate objective while generalizing. The loss defines the target, backpropagation assigns local responsibility through gradients, the optimizer turns those gradients into updates, and repeated, monitored passes gradually produce useful behavior.

Across this loop, automatic differentiation implements bookkeeping, while the mathematical feedback remains the gradient of the chosen loss.`,
  },
  {
    id: "mlai-fde-e04",
    version: 1,
    answer: `An embedding is a learned, fixed-length vector of numbers that represents an input such as a word, sentence, image, user, or document. It is dense because many coordinates can contribute to the representation, unlike a sparse identifier or one-hot vector. Individual coordinates usually do not store readable definitions. Meaning arises from the geometry learned through the model's training objective and data.

Embedding models are trained so that inputs useful for the same objective receive related representations. For text, sentences that express similar ideas can end up close in vector space even when they share few exact words. For example, a query about resetting a password may be near a document describing account credential recovery. Their vocabulary differs, but the model can encode a related intent. Conversely, identical words used in different contexts may need different representations.

Semantic search exploits that geometry. A system divides its corpus into suitable items or chunks, computes and stores an embedding for each, and embeds an incoming query with the compatible model. It then calculates a similarity measure, commonly cosine similarity or a dot product, and retrieves the nearest vectors. Approximate nearest-neighbor indexes make this efficient at large scale. Because matching happens in the learned representation rather than only through literal tokens, the search can recover paraphrases, synonyms, and conceptually related passages that keyword search might miss.

Vector proximity is not proof of truth, relevance, or agreement. Similarity reflects patterns emphasized by a particular model, training corpus, and objective. An embedding may place a false claim near a question about that claim, retrieve text that discusses a topic without answering it, or miss specialized terminology absent from training. A general model can perform poorly in legal, medical, multilingual, or company-specific domains. Ambiguous short queries can also lack enough context to express the user's intended meaning.

Implementation details affect results. Queries and documents must use embeddings intended to share a space. If cosine similarity is implemented through dot products, vectors are typically normalized; otherwise magnitude can distort ranking. Chunk size changes the balance between focused meaning and sufficient context. Metadata filters can enforce language, date, tenant, or document-type constraints before similarity ranking.

Robust systems often combine dense retrieval with sparse keyword retrieval so exact names, codes, and rare terms remain discoverable. A reranker can examine the query and a small candidate set together, providing more precise ordering at extra latency and cost. Domain-adapted embeddings may improve specialized retrieval but require representative evaluation and operational maintenance.

Quality should be measured on real query-relevance judgments using recall at a candidate cutoff, ranking metrics, and important slices, not inferred from visually pleasing vector plots. Search logs and failure analysis can reveal ambiguity, stale content, or domain gaps. Embeddings enable semantic search because learned distance can approximate useful relatedness; they remain fallible, model-dependent signals that work best with filters, hybrid retrieval, reranking, and evaluation.

Privacy and freshness matter too: indexes can expose unauthorized documents or retain deleted content unless ingestion, filtering, and cache invalidation are designed as explicit security boundaries.`,
  },
  {
    id: "mlai-fde-e05",
    version: 1,
    answer: `Retrieval-augmented generation, or RAG, and fine-tuning change different parts of an LLM application. RAG supplies selected external information when a request is answered. Fine-tuning updates model weights using training examples. The first primarily changes what evidence is available at inference time; the second primarily changes learned behavior.

In a typical RAG system, content is collected, divided into chunks, indexed, and retrieved for each query. The application places relevant passages in the model's context and asks it to answer from them, often with citations. RAG is a strong fit for changing facts, private organizational documents, large catalogs, or domains where users need traceable sources. Updating the index can expose new information without retraining the base model, and access controls can be applied during retrieval.

RAG quality depends on the entire retrieval pipeline. Poor chunking, missing documents, weak embeddings, inappropriate keyword matching, stale indexes, or incorrect metadata filters can omit decisive evidence. Retrieving irrelevant or contradictory passages can confuse generation, while too much context can bury useful details or exceed limits. The model may still ignore, misread, or invent claims beyond retrieved evidence. RAG therefore needs retrieval evaluation, source-quality controls, reranking, grounded prompts, citations, and answer-level checks; it does not train the base model or guarantee truth.

Fine-tuning presents curated examples and adjusts some or all model parameters. It is useful when the desired capability is stable and repeated: following a specialized format, adopting a consistent tone, mapping inputs to labels, using domain terminology, or performing a task that prompting alone handles unreliably. Parameter-efficient methods can modify a small set of added or selected parameters, reducing compute and storage compared with full fine-tuning.

Fine-tuning is usually a poor substitute for a current factual database. Facts encoded in weights are difficult to inspect, cite, correct individually, or refresh quickly. Training examples can be incomplete, biased, or memorized, and adaptation can degrade unrelated abilities. Fine-tuning therefore requires held-out task evaluation, broad regression and safety tests, careful data governance, and monitoring. It does not automatically make outputs factual or keep knowledge current.

The decision should begin with a clear failure analysis. If the model lacks fresh, private, attributable evidence, use RAG. If it has the needed information but consistently fails to follow a stable behavior or output contract, consider fine-tuning. Prompting, structured output constraints, examples in context, or tool use are cheaper baselines and may solve the problem without either complex pipeline.

The approaches are complementary. A fine-tuned model can learn how to formulate searches, interpret retrieved passages, cite sources, and abstain when evidence is insufficient, while RAG supplies the changeable knowledge. A production system might therefore fine-tune behavior and retrieve facts. Choose using representative end-to-end evaluations of answer quality, retrieval recall, factual support, latency, cost, security, and maintenance burden rather than assuming one technique is universally superior.

Operationally, RAG adds indexing, retrieval latency, and source-availability dependencies; fine-tuning adds dataset curation, training, versioning, and rollback. Cost comparisons must include those lifecycle burdens. The better fit is the one with failure modes the team can control.`,
  },
  {
    id: "mlai-fde-e06",
    version: 1,
    answer: `An LLM hallucination is an output that sounds coherent and confident but contains claims unsupported by the available evidence or simply incorrect. It can include invented facts, citations, quotations, tool results, or reasoning steps. Hallucination is not intentional deception: the model has no inherent intention to lie and no built-in, authoritative database against which every generated statement is checked.

A language model learns statistical patterns in training data and generates a sequence by predicting plausible next tokens from its prompt and prior output. That objective rewards linguistic likelihood, not guaranteed factual verification. Training data can be incomplete, inconsistent, outdated, or sparse for the requested topic. A vague prompt, missing context, unfamiliar entity, long reasoning chain, or distribution shift can leave several plausible continuations. The model may then produce a fluent completion that fills gaps rather than reliably signaling ignorance.

Grounding supplies evidence the answer should use. Retrieval-augmented generation can fetch relevant, current, or private documents, while tool calls can obtain database records, calculations, or live system state. Prompts can require claims to follow provided sources and ask the model to distinguish evidence from inference. Citations make support inspectable, but they should be programmatically checked: a citation can exist yet fail to entail its associated claim.

Grounding is not a guarantee. Retrieval may miss the correct passage, return stale or malicious content, or rank a topically similar false statement highly. The generator may ignore good evidence or combine passages incorrectly. Systems should measure retrieval recall, filter sources by provenance and permissions, rerank candidates, preserve enough context, and test whether cited text actually supports the response.

Constrained tools and validation reduce impact further. Structured output schemas prevent malformed fields but not false values, so critical outputs should be checked against deterministic rules, databases, calculators, or domain-specific validators. Workflows can restrict actions to allowlisted tools, require confirmation before consequential operations, and separate model proposals from execution. For high-stakes claims, human review or independent authoritative verification may be necessary.

The application should permit calibrated abstention: when evidence is absent, conflicting, or below a quality threshold, it should say that it cannot answer reliably, ask a clarifying question, or route the case elsewhere. Interfaces can expose sources and uncertainty without presenting the model's self-reported confidence as a measured probability.

Lowering temperature generally reduces sampling variability, but even deterministic decoding can repeatedly select the same false completion; temperature is not the root cause and zero does not eliminate hallucinations. Teams should maintain representative factuality and groundedness evaluations, adversarial cases, regression tests, slice metrics, and production monitoring. They should track unsupported-claim rates and downstream harm, not only answer fluency.

No mitigation removes all risk. The appropriate design layers better context, verified retrieval, constrained tools, citations, validation, abstention, evaluation, and human oversight according to consequence. The goal is to prevent unsupported text from being trusted or acted upon, while detecting failures quickly when they still occur.

Clear user communication is another safeguard: generated text should not masquerade as verified fact, especially when evidence or review is still incomplete.`,
  },
  {
    id: "mlai-fde-e07",
    version: 1,
    answer: `Data drift and concept drift describe different ways production conditions can depart from those used to develop a model. Data drift is a change in the distribution of inputs. Concept drift is a change in the relationship between inputs and the outcome the model is meant to predict.

Suppose a credit model receives applicants whose income ranges, regions, or device types change after launch. Those feature-distribution changes are data drift, even before outcomes are known. By contrast, if the default risk associated with the same income and debt profile changes because of an economic shock, the mapping from features to label has changed; that is concept drift. Label shift, where outcome prevalence changes, is another relevant distribution change and may occur with or without broader feature drift.

Input monitoring should compare production features with a reference such as training data or a recent healthy period. Teams can track missingness, ranges, category frequencies, quantiles, schema violations, embedding or aggregate distribution distances, and the rate of novel values. Metrics should be segmented by important cohorts, geography, product surface, and model version because aggregate stability can hide a failing slice. Alerts need practical baselines, tolerances, sample-size safeguards, and seasonality awareness; otherwise normal weekly variation produces noise.

Input drift alone does not prove model quality has declined. A shifted feature may be irrelevant, and a model may remain robust within the new range. Conversely, stable marginal inputs do not guarantee stable accuracy because relationships among features or between features and outcomes can change. Concept drift is best detected with labels: once outcomes arrive, monitor task metrics such as loss, precision, recall, calibration, or ranking quality over time and by slice. Compare against baselines and uncertainty intervals rather than reacting to tiny random movements.

Labels are often delayed, incomplete, or selectively observed, so leading indicators are also useful. Monitor prediction distributions, confidence or uncertainty, calibration proxies, abstention and fallback rates, disagreement with a shadow model, and rates of human overrides. These signals can prompt investigation, but they are not substitutes for eventual labeled evaluation. Feedback loops require special care: model decisions can influence which cases receive labels, alter user behavior, and make observed outcomes unrepresentative.

Operational monitoring complements statistical monitoring. Track latency, throughput, timeouts, error rates, feature freshness, failed joins, upstream schema changes, and data-pipeline availability. A perfectly accurate model is still unusable if features are stale or requests fail, while healthy infrastructure says nothing about predictive quality.

When an alert fires, verify data integrity, localize affected features and cohorts, examine recent product or policy changes, and backfill labels where possible. Responses may include repairing a pipeline, changing thresholds, recalibrating, collecting representative data, retraining, restricting use, or rolling back. Not every detected drift warrants retraining; the action should follow demonstrated performance or safety impact.

A sound production system therefore combines distribution checks, delayed labeled metrics, calibration and confidence signals, slice analysis, operational health, and feedback-loop audits. It records model and data versions, uses staged alerts, and validates any remedy on untouched representative data before deployment.`,
  },
] as const);
