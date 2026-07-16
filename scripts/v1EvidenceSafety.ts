import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { redactSecrets } from "../src/safety/redaction.js";

export interface RecordedEvidenceLike {
  readonly id?: number | undefined;
  readonly verified_at?: string | undefined;
  readonly evidence: string;
  readonly command?: string | undefined;
  readonly artifact?: string | undefined;
}

const FUTURE_TIMESTAMP_SKEW_MS = 60_000;

export function recordedEvidenceSafetyProblem(
  root: string,
  evidence: RecordedEvidenceLike,
  now = new Date(),
): string | undefined {
  const timestampProblem = evidence.verified_at
    ? verifiedAtSafetyProblem(evidence.verified_at, now)
    : undefined;
  if (timestampProblem) {
    return timestampProblem;
  }

  const evidenceProblem = recordedEvidenceTextSafetyProblem(
    "summary",
    evidence.evidence,
  );
  if (evidenceProblem) {
    return evidenceProblem;
  }

  if (evidence.command) {
    const commandProblem = recordedEvidenceTextSafetyProblem(
      "command",
      evidence.command,
    );
    if (commandProblem) {
      return commandProblem;
    }
  }

  return evidence.artifact
    ? evidenceArtifactSafetyProblem(root, evidence.artifact, evidence.id)
    : undefined;
}

export function evidenceTextSafetyProblem(
  label: string,
  text: string,
): string | undefined {
  return evidenceSecretLikeTextProblem(label, text);
}

export function recordedEvidenceTextSafetyProblem(
  label: string,
  text: string,
): string | undefined {
  const secretProblem = evidenceTextSafetyProblem(label, text);
  if (secretProblem) {
    return secretProblem;
  }

  return unfilledPlaceholderPattern().test(text)
    ? `V1 evidence ${label} contains unfilled placeholder text; replace it before recording evidence.`
    : undefined;
}

export function verifiedAtSafetyProblem(
  verifiedAt: string,
  now = new Date(),
): string | undefined {
  const parsed = Date.parse(verifiedAt);
  if (Number.isNaN(parsed)) {
    return "V1 evidence verified_at must be a parseable timestamp.";
  }

  return parsed - now.getTime() > FUTURE_TIMESTAMP_SKEW_MS
    ? `V1 evidence verified_at is in the future: ${verifiedAt}.`
    : undefined;
}

export function evidenceArtifactSafetyProblem(
  root: string,
  artifact: string,
  gateId?: number | undefined,
): string | undefined {
  const artifactPath = resolve(root, artifact);
  const relativePath = relative(root, artifactPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return `Artifact path is outside the project: ${artifact}.`;
  }

  if (!existsSync(artifactPath)) {
    return `Artifact is missing: ${artifact}.`;
  }

  return scanEvidenceArtifactText(artifactPath, artifact, gateId);
}

export function scanEvidenceArtifactText(
  filePath: string,
  artifact: string,
  gateId?: number | undefined,
): string | undefined {
  if (!statSync(filePath).isFile()) {
    return `Evidence artifact is not a file: ${artifact}.`;
  }

  const contents = readFileSync(filePath);
  if (isLikelyBinary(contents)) {
    return undefined;
  }

  const text = contents.toString("utf8");
  const secretProblem = evidenceSecretLikeTextProblem(
    `artifact ${artifact}`,
    text,
  );
  if (secretProblem) {
    return secretProblem;
  }

  const draftBodyMatch = draftBodyArtifactPattern().exec(text);
  if (draftBodyMatch) {
    return `Evidence artifact contains draft-body-like field ${draftBodyMatch[1]}: ${artifact}.`;
  }

  if (uncheckedChecklistPattern().test(text)) {
    return `Evidence artifact contains unchecked checklist items: ${artifact}.`;
  }

  if (unfilledPlaceholderPattern().test(text)) {
    return `Evidence artifact contains unfilled placeholder text: ${artifact}.`;
  }

  const gateStructureProblem = gateEvidenceArtifactStructureProblem(
    artifact,
    text,
    gateId,
  );
  if (gateStructureProblem) {
    return gateStructureProblem;
  }

  const gateDetailProblem = gateEvidenceArtifactDetailProblem(
    artifact,
    text,
    gateId,
  );
  if (gateDetailProblem) {
    return gateDetailProblem;
  }

  const cloudRunProblem = cloudRunEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (cloudRunProblem) {
    return cloudRunProblem;
  }

  const cloudRunLogsProblem = cloudRunLogsEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (cloudRunLogsProblem) {
    return cloudRunLogsProblem;
  }

  const staticBearerProblem = staticBearerRemoteEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (staticBearerProblem) {
    return staticBearerProblem;
  }

  const chatGptNgrokProblem = chatGptNgrokEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (chatGptNgrokProblem) {
    return chatGptNgrokProblem;
  }

  const localStdioProblem = localStdioEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (localStdioProblem) {
    return localStdioProblem;
  }

  const remoteOAuthProblem = remoteOAuthEvidenceArtifactProblem(artifact, text);
  if (remoteOAuthProblem) {
    return remoteOAuthProblem;
  }

  const liveSubstackProblem = liveSubstackEvidenceArtifactProblem(
    artifact,
    text,
    gateId,
  );
  if (liveSubstackProblem) {
    return liveSubstackProblem;
  }

  return undefined;
}

function isLikelyBinary(contents: Buffer): boolean {
  return contents.subarray(0, 1024).includes(0);
}

function draftBodyArtifactPattern(): RegExp {
  return /\b(draft_body|draftBody|body_markdown|bodyMarkdown|body_json|bodyJson|request_body|requestBody|raw_body|rawBody)\b/;
}

function evidenceSecretLikeTextProblem(
  label: string,
  text: string,
): string | undefined {
  return redactSecrets(text) === text
    ? undefined
    : `V1 evidence ${label} contains secret-like content; redact it before recording evidence.`;
}

function uncheckedChecklistPattern(): RegExp {
  return /^[ \t]*[-*][ \t]+\[[ \t]\][ \t]+/m;
}

function unfilledPlaceholderPattern(): RegExp {
  return /<(?:replace with [^>\n]+|this file|[a-z][a-z0-9_-]*(?:[ _./:-]+[a-z0-9_-]+)*)>/iu;
}

function gateEvidenceArtifactStructureProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId === undefined) {
    return undefined;
  }

  const headings = requiredGateEvidenceHeadings(gateId);
  if (headings.length === 0) {
    return undefined;
  }

  return headings.some((heading) => text.includes(heading))
    ? undefined
    : `Evidence artifact is missing a gate ${gateId} detail section (${headings.join(" or ")}): ${artifact}.`;
}

function requiredGateEvidenceHeadings(gateId: number): readonly string[] {
  switch (gateId) {
    case 7:
      return ["## Gate 7 Manual Review Details", "## Manual Review Checklist"];
    case 8:
      return ["## Gate 8 Update Review Details"];
    case 9:
      return ["## Gate 9 Read Review Details"];
    case 11:
      return [
        "## Gate 11 ChatGPT Connector Details",
        "## Manual ChatGPT Connector Acceptance",
      ];
    case 12:
      return [
        "## Gate 12 Cloud Run Deployment Details",
        "## Gate 12 Deployment Review Details",
      ];
    case 13:
      return [
        "## Gate 13 Secret Manager Details",
        "## Gate 13 Secret Manager Review Details",
      ];
    case 14:
      return [
        "## Gate 14 Header-Capable Client Details",
        "## Manual Header-Capable Client Acceptance",
      ];
    case 15:
      return [
        "## Gate 15 Manual Client Details",
        "## Manual Client Acceptance",
      ];
    case 16:
      return [
        "## Gate 16 Cloud Run Log Review Details",
        "## Manual Log Review Details",
      ];
    default:
      return [];
  }
}

function gateEvidenceArtifactDetailProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId === undefined) {
    return undefined;
  }

  const fields = requiredGateDetailFields(gateId);
  if (fields.length === 0) {
    return undefined;
  }

  let gate7FixtureReadinessCommand = "";
  let gate7FixtureCompatibilityCommand = "";
  let gate7FixtureProvenanceReview = "";
  let gate7DraftUrlOrId = "";
  let gate7TitleSubtitleReview = "";
  let gate7TextFormattingReview = "";
  let gate7ImageRenderingReview = "";
  let gate7NativeCodeBlockRenderingReview = "";
  let gate7NativeLatexRenderingReview = "";
  let gate7SubstackPreviewReview = "";
  let gate7UnpublishedStatusReview = "";
  let gate7CleanupDecision = "";
  let gate8DraftUrlOrId = "";
  let gate8CreatedTitleBeforeUpdate = "";
  let gate8UpdatedTitleAfterUpdate = "";
  let gate8UpdateCommand = "";
  let gate8FieldUpdateReview = "";
  let gate8UnpublishedStatusAfterUpdate = "";
  let gate8PostUpdateGetDraftReview = "";
  let gate8DraftBodyHandlingReview = "";
  let gate8CleanupDecision = "";
  let gate9DraftUrlOrIdRead = "";
  let gate9ListDraftsResult = "";
  let gate9GetDraftResult = "";
  let gate9MetadataFieldsReviewed = "";
  let gate9BodyInclusionReview = "";
  let gate9PostUpdateReadbackReview = "";
  let gate9RawBodyContentHandling = "";
  let gate9FollowUpAction = "";
  let gate11ConnectorUrl = "";
  let gate11ChatGptSurfaceTested = "";
  let gate11ToolListResult = "";
  let gate11ManualFlowResult = "";
  let gate11DraftOrReviewReference = "";
  let gate11TunnelExposureWindow = "";
  let gate11UnexpectedTrafficReview = "";
  let gate11RotationDecision = "";
  let gate12GcpProjectRegionService = "";
  let gate12ServiceUrlChecked = "";
  let gate12DeployCommandSource = "";
  let gate12HealthCheckResult = "";
  let gate12RemoteSmokeResult = "";
  let gate12AuthModeDeployed = "";
  let gate12BudgetGuardReview = "";
  let gate12PathSecretReview = "";
  let gate13LiteralEnvReview = "";
  let gate13SecretValueHandling = "";
  let gate13SecretReferencesChecked = "";
  let gate13RequiredSecretNames = "";
  let gate13RuntimeServiceAccount = "";
  let gate13SecretAccessBindings = "";
  let gate13VersionPolicy = "";
  let gate13RotationFollowUp = "";
  let gate14ClientTested = "";
  let gate14EndpointTested = "";
  let gate14HeaderConfigurationMethod = "";
  let gate14ToolListResult = "";
  let gate14ValidationCallResult = "";
  let gate14RejectionProof = "";
  let gate14TokenRedactionReview = "";
  let gate15ClientTested = "";
  let gate15ConfigPathOrAddCommand = "";
  let gate15ServerEntrypointPath = "";
  let gate15ToolListResult = "";
  let gate15ValidationCallResult = "";
  let gate15CredentialLocalityReview = "";
  let gate16LogExportWindow = "";
  let gate16CloudRunServiceRevision = "";
  let gate16LiveTrafficExercised = "";
  let gate16LogExportCommand = "";
  let gate16VerifierCommand = "";
  let gate16AuditEventReview = "";
  let gate16FindingReview = "";
  let gate16RawLogHandling = "";
  let gate16FollowUpAction = "";
  for (const field of fields) {
    const value = markdownListFieldValue(text, field);
    if (value === undefined) {
      return `Evidence artifact is missing gate ${gateId} detail field ${field}: ${artifact}.`;
    }
    if (value.trim().length === 0) {
      return `Evidence artifact has empty gate ${gateId} detail field ${field}: ${artifact}.`;
    }
    if (gateId === 7 && field === "Fixture readiness command") {
      gate7FixtureReadinessCommand = value;
    }
    if (gateId === 7 && field === "Fixture compatibility command") {
      gate7FixtureCompatibilityCommand = value;
    }
    if (gateId === 7 && field === "Fixture provenance review") {
      gate7FixtureProvenanceReview = value;
    }
    if (gateId === 7 && field === "Draft URL or ID") {
      gate7DraftUrlOrId = value;
    }
    if (gateId === 7 && field === "Title/subtitle review") {
      gate7TitleSubtitleReview = value;
    }
    if (gateId === 7 && field === "Text formatting review") {
      gate7TextFormattingReview = value;
    }
    if (gateId === 7 && field === "Image rendering review") {
      gate7ImageRenderingReview = value;
    }
    if (gateId === 7 && field === "Native code block rendering review") {
      gate7NativeCodeBlockRenderingReview = value;
    }
    if (gateId === 7 && field === "Native LaTeX rendering review") {
      gate7NativeLatexRenderingReview = value;
    }
    if (gateId === 7 && field === "Substack preview review") {
      gate7SubstackPreviewReview = value;
    }
    if (gateId === 7 && field === "Unpublished status review") {
      gate7UnpublishedStatusReview = value;
    }
    if (gateId === 7 && field === "Cleanup decision") {
      gate7CleanupDecision = value;
    }
    if (gateId === 8 && field === "Draft URL or ID") {
      gate8DraftUrlOrId = value;
    }
    if (gateId === 8 && field === "Created title before update") {
      gate8CreatedTitleBeforeUpdate = value;
    }
    if (gateId === 8 && field === "Updated title after update") {
      gate8UpdatedTitleAfterUpdate = value;
    }
    if (gateId === 8 && field === "Update command") {
      gate8UpdateCommand = value;
    }
    if (gateId === 8 && field === "Field update review") {
      gate8FieldUpdateReview = value;
    }
    if (gateId === 8 && field === "Unpublished status after update") {
      gate8UnpublishedStatusAfterUpdate = value;
    }
    if (gateId === 8 && field === "Post-update `get_draft` review") {
      gate8PostUpdateGetDraftReview = value;
    }
    if (gateId === 8 && field === "Draft body handling review") {
      gate8DraftBodyHandlingReview = value;
    }
    if (gateId === 8 && field === "Cleanup decision") {
      gate8CleanupDecision = value;
    }
    if (gateId === 9 && field === "Draft URL or ID read") {
      gate9DraftUrlOrIdRead = value;
    }
    if (gateId === 9 && field === "`list_drafts` result") {
      gate9ListDraftsResult = value;
    }
    if (gateId === 9 && field === "`get_draft` result") {
      gate9GetDraftResult = value;
    }
    if (gateId === 9 && field === "Metadata fields reviewed") {
      gate9MetadataFieldsReviewed = value;
    }
    if (gateId === 9 && field === "Body inclusion review") {
      gate9BodyInclusionReview = value;
    }
    if (gateId === 9 && field === "Post-update readback review") {
      gate9PostUpdateReadbackReview = value;
    }
    if (gateId === 9 && field === "Raw body/content handling") {
      gate9RawBodyContentHandling = value;
    }
    if (gateId === 9 && field === "Follow-up action") {
      gate9FollowUpAction = value;
    }
    if (gateId === 11 && field === "Connector URL") {
      gate11ConnectorUrl = value;
    }
    if (gateId === 11 && field === "ChatGPT surface tested") {
      gate11ChatGptSurfaceTested = value;
    }
    if (gateId === 11 && field === "Tool-list result") {
      gate11ToolListResult = value;
    }
    if (gateId === 11 && field === "Manual flow result") {
      gate11ManualFlowResult = value;
    }
    if (gateId === 11 && field === "Draft or review reference") {
      gate11DraftOrReviewReference = value;
    }
    if (gateId === 11 && field === "Tunnel exposure window") {
      gate11TunnelExposureWindow = value;
    }
    if (gateId === 11 && field === "Unexpected traffic review") {
      gate11UnexpectedTrafficReview = value;
    }
    if (gateId === 11 && field === "Rotation decision") {
      gate11RotationDecision = value;
    }
    if (gateId === 12 && field === "GCP project/region/service") {
      gate12GcpProjectRegionService = value;
    }
    if (gateId === 12 && field === "Service URL checked") {
      gate12ServiceUrlChecked = value;
    }
    if (gateId === 12 && field === "Deploy command source") {
      gate12DeployCommandSource = value;
    }
    if (gateId === 12 && field === "Health check result") {
      gate12HealthCheckResult = value;
    }
    if (gateId === 12 && field === "Remote smoke result") {
      gate12RemoteSmokeResult = value;
    }
    if (gateId === 12 && field === "Auth mode deployed") {
      gate12AuthModeDeployed = value;
    }
    if (gateId === 12 && field === "Budget guard review") {
      gate12BudgetGuardReview = value;
    }
    if (gateId === 12 && field === "Path-secret review") {
      gate12PathSecretReview = value;
    }
    if (gateId === 13 && field === "Literal env review") {
      gate13LiteralEnvReview = value;
    }
    if (gateId === 13 && field === "Secret value handling") {
      gate13SecretValueHandling = value;
    }
    if (gateId === 13 && field === "Secret references checked") {
      gate13SecretReferencesChecked = value;
    }
    if (gateId === 13 && field === "Required secret names") {
      gate13RequiredSecretNames = value;
    }
    if (gateId === 13 && field === "Runtime service account") {
      gate13RuntimeServiceAccount = value;
    }
    if (gateId === 13 && field === "Secret access bindings") {
      gate13SecretAccessBindings = value;
    }
    if (gateId === 13 && field === "Version policy") {
      gate13VersionPolicy = value;
    }
    if (gateId === 13 && field === "Rotation follow-up") {
      gate13RotationFollowUp = value;
    }
    if (gateId === 14 && field === "Client tested") {
      gate14ClientTested = value;
    }
    if (gateId === 14 && field === "Endpoint tested") {
      gate14EndpointTested = value;
    }
    if (gateId === 14 && field === "Header configuration method") {
      gate14HeaderConfigurationMethod = value;
    }
    if (gateId === 14 && field === "Tool-list result") {
      gate14ToolListResult = value;
    }
    if (gateId === 14 && field === "Validation call result") {
      gate14ValidationCallResult = value;
    }
    if (gateId === 14 && field === "Rejection proof") {
      gate14RejectionProof = value;
    }
    if (gateId === 14 && field === "Token redaction review") {
      gate14TokenRedactionReview = value;
    }
    if (gateId === 15 && field === "Client tested") {
      gate15ClientTested = value;
    }
    if (gateId === 15 && field === "Config path or add command") {
      gate15ConfigPathOrAddCommand = value;
    }
    if (gateId === 15 && field === "Server entrypoint path") {
      gate15ServerEntrypointPath = value;
    }
    if (gateId === 15 && field === "Tool-list result") {
      gate15ToolListResult = value;
    }
    if (gateId === 15 && field === "Validation call result") {
      gate15ValidationCallResult = value;
    }
    if (gateId === 15 && field === "Credential locality review") {
      gate15CredentialLocalityReview = value;
    }
    if (gateId === 16 && field === "Log export window") {
      gate16LogExportWindow = value;
    }
    if (gateId === 16 && field === "Cloud Run service/revision") {
      gate16CloudRunServiceRevision = value;
    }
    if (gateId === 16 && field === "Live traffic exercised") {
      gate16LiveTrafficExercised = value;
    }
    if (gateId === 16 && field === "Log export command") {
      gate16LogExportCommand = value;
    }
    if (gateId === 16 && field === "Verifier command") {
      gate16VerifierCommand = value;
    }
    if (gateId === 16 && field === "Audit event review") {
      gate16AuditEventReview = value;
    }
    if (gateId === 16 && field === "Finding review") {
      gate16FindingReview = value;
    }
    if (gateId === 16 && field === "Raw log handling") {
      gate16RawLogHandling = value;
    }
    if (gateId === 16 && field === "Follow-up action") {
      gate16FollowUpAction = value;
    }
  }

  const gate7FixtureReadinessProblem = gate7FixtureReadinessCommandProblem(
    artifact,
    gateId,
    gate7FixtureReadinessCommand,
  );
  if (gate7FixtureReadinessProblem) {
    return gate7FixtureReadinessProblem;
  }

  const gate7FixtureCompatibilityProblem =
    gate7FixtureCompatibilityCommandProblem(
      artifact,
      gateId,
      gate7FixtureCompatibilityCommand,
    );
  if (gate7FixtureCompatibilityProblem) {
    return gate7FixtureCompatibilityProblem;
  }

  const gate7ProvenanceProblem = gate7FixtureProvenanceProblem(
    artifact,
    gateId,
    gate7FixtureProvenanceReview,
  );
  if (gate7ProvenanceProblem) {
    return gate7ProvenanceProblem;
  }

  const gate7DraftReferenceProblem = gate7DraftUrlOrIdProblem(
    artifact,
    gateId,
    gate7DraftUrlOrId,
  );
  if (gate7DraftReferenceProblem) {
    return gate7DraftReferenceProblem;
  }

  const gate7TitleReviewProblem = gate7TitleSubtitleReviewProblem(
    artifact,
    gateId,
    gate7TitleSubtitleReview,
  );
  if (gate7TitleReviewProblem) {
    return gate7TitleReviewProblem;
  }

  const gate7DraftStatusProblem = gateDraftStatusProblem(
    artifact,
    gateId,
    "Unpublished status review",
    gate7UnpublishedStatusReview,
  );
  if (gate7DraftStatusProblem) {
    return gate7DraftStatusProblem;
  }

  const gate7RichRenderingProblem = gate7RichRenderingReviewProblem(artifact, {
    gateId,
    textFormattingReview: gate7TextFormattingReview,
    imageRenderingReview: gate7ImageRenderingReview,
    nativeCodeBlockRenderingReview: gate7NativeCodeBlockRenderingReview,
    nativeLatexRenderingReview: gate7NativeLatexRenderingReview,
    substackPreviewReview: gate7SubstackPreviewReview,
  });
  if (gate7RichRenderingProblem) {
    return gate7RichRenderingProblem;
  }

  const gate7CleanupProblem = gate7CleanupDecisionProblem(
    artifact,
    gateId,
    gate7CleanupDecision,
  );
  if (gate7CleanupProblem) {
    return gate7CleanupProblem;
  }

  const gate8DraftReferenceProblem = gate8DraftUrlOrIdProblem(
    artifact,
    gateId,
    gate8DraftUrlOrId,
  );
  if (gate8DraftReferenceProblem) {
    return gate8DraftReferenceProblem;
  }

  const gate8DraftStatusProblem = gateDraftStatusProblem(
    artifact,
    gateId,
    "Unpublished status after update",
    gate8UnpublishedStatusAfterUpdate,
  );
  if (gate8DraftStatusProblem) {
    return gate8DraftStatusProblem;
  }

  const gate8TitleTransitionProblem = gate8UpdatedTitleTransitionProblem(
    artifact,
    gateId,
    gate8CreatedTitleBeforeUpdate,
    gate8UpdatedTitleAfterUpdate,
  );
  if (gate8TitleTransitionProblem) {
    return gate8TitleTransitionProblem;
  }

  const gate8UpdateCommandIssue = gate8UpdateCommandProblem(
    artifact,
    gateId,
    gate8UpdateCommand,
  );
  if (gate8UpdateCommandIssue) {
    return gate8UpdateCommandIssue;
  }

  const gate8FieldUpdateProblem = gate8FieldUpdateReviewProblem(
    artifact,
    gateId,
    gate8FieldUpdateReview,
  );
  if (gate8FieldUpdateProblem) {
    return gate8FieldUpdateProblem;
  }

  const gate8PostUpdateReadbackProblem = gate8PostUpdateGetDraftReviewProblem(
    artifact,
    gateId,
    gate8PostUpdateGetDraftReview,
  );
  if (gate8PostUpdateReadbackProblem) {
    return gate8PostUpdateReadbackProblem;
  }

  const gate8DraftBodyProblem = gate8DraftBodyHandlingReviewProblem(
    artifact,
    gateId,
    gate8DraftBodyHandlingReview,
  );
  if (gate8DraftBodyProblem) {
    return gate8DraftBodyProblem;
  }

  const gate8CleanupProblem = gate8CleanupDecisionProblem(
    artifact,
    gateId,
    gate8CleanupDecision,
  );
  if (gate8CleanupProblem) {
    return gate8CleanupProblem;
  }

  const gate9DraftReferenceProblem = gate9DraftUrlOrIdReadProblem(
    artifact,
    gateId,
    gate9DraftUrlOrIdRead,
  );
  if (gate9DraftReferenceProblem) {
    return gate9DraftReferenceProblem;
  }

  const gate9ListDraftsProblem = gate9ListDraftsResultProblem(
    artifact,
    gateId,
    gate9ListDraftsResult,
  );
  if (gate9ListDraftsProblem) {
    return gate9ListDraftsProblem;
  }

  const gate9GetDraftProblem = gate9GetDraftResultProblem(
    artifact,
    gateId,
    gate9GetDraftResult,
  );
  if (gate9GetDraftProblem) {
    return gate9GetDraftProblem;
  }

  const gate9MetadataProblem = gate9MetadataFieldsReviewedProblem(
    artifact,
    gateId,
    gate9MetadataFieldsReviewed,
  );
  if (gate9MetadataProblem) {
    return gate9MetadataProblem;
  }

  const gate9BodyInclusionProblem = gate9BodyInclusionReviewProblem(
    artifact,
    gateId,
    gate9BodyInclusionReview,
  );
  if (gate9BodyInclusionProblem) {
    return gate9BodyInclusionProblem;
  }

  const gate9PostUpdateReadbackProblem = gate9PostUpdateReadbackReviewProblem(
    artifact,
    gateId,
    gate9PostUpdateReadbackReview,
  );
  if (gate9PostUpdateReadbackProblem) {
    return gate9PostUpdateReadbackProblem;
  }

  const gate9RawBodyProblem = gate9RawBodyContentHandlingProblem(
    artifact,
    gateId,
    gate9RawBodyContentHandling,
  );
  if (gate9RawBodyProblem) {
    return gate9RawBodyProblem;
  }

  const gate9FollowUpProblem = gate9FollowUpActionProblem(
    artifact,
    gateId,
    gate9FollowUpAction,
  );
  if (gate9FollowUpProblem) {
    return gate9FollowUpProblem;
  }

  const gate11ConnectorProblem = gate11ConnectorUrlProblem(
    artifact,
    gateId,
    gate11ConnectorUrl,
  );
  if (gate11ConnectorProblem) {
    return gate11ConnectorProblem;
  }

  const gate11ChatGptSurfaceProblem = gate11ChatGptSurfaceTestedProblem(
    artifact,
    gateId,
    gate11ChatGptSurfaceTested,
  );
  if (gate11ChatGptSurfaceProblem) {
    return gate11ChatGptSurfaceProblem;
  }

  const gate11ToolListProblem = gate11ToolListResultProblem(
    artifact,
    gateId,
    gate11ToolListResult,
  );
  if (gate11ToolListProblem) {
    return gate11ToolListProblem;
  }

  const gate11ManualFlowProblem = gate11ManualFlowResultProblem(
    artifact,
    gateId,
    gate11ManualFlowResult,
  );
  if (gate11ManualFlowProblem) {
    return gate11ManualFlowProblem;
  }

  const gate11DraftReferenceProblem = gate11DraftOrReviewReferenceProblem(
    artifact,
    gateId,
    gate11DraftOrReviewReference,
  );
  if (gate11DraftReferenceProblem) {
    return gate11DraftReferenceProblem;
  }

  const gate11TunnelWindowProblem = gate11TunnelExposureWindowProblem(
    artifact,
    gateId,
    gate11TunnelExposureWindow,
  );
  if (gate11TunnelWindowProblem) {
    return gate11TunnelWindowProblem;
  }

  const gate11TrafficReviewProblem = gate11UnexpectedTrafficReviewProblem(
    artifact,
    gateId,
    gate11UnexpectedTrafficReview,
  );
  if (gate11TrafficReviewProblem) {
    return gate11TrafficReviewProblem;
  }

  const gate11RotationProblem = gate11RotationDecisionProblem(
    artifact,
    gateId,
    gate11RotationDecision,
  );
  if (gate11RotationProblem) {
    return gate11RotationProblem;
  }

  const gate12ProjectProblem = gate12GcpProjectRegionServiceProblem(
    artifact,
    gateId,
    gate12GcpProjectRegionService,
  );
  if (gate12ProjectProblem) {
    return gate12ProjectProblem;
  }

  const gate12ServiceUrlProblem = gate12ServiceUrlCheckedProblem(
    artifact,
    gateId,
    gate12ServiceUrlChecked,
  );
  if (gate12ServiceUrlProblem) {
    return gate12ServiceUrlProblem;
  }

  const gate12DeploySourceProblem = gate12DeployCommandSourceProblem(
    artifact,
    gateId,
    gate12DeployCommandSource,
  );
  if (gate12DeploySourceProblem) {
    return gate12DeploySourceProblem;
  }

  const gate12HealthCheckProblem = gate12HealthCheckResultProblem(
    artifact,
    gateId,
    gate12HealthCheckResult,
  );
  if (gate12HealthCheckProblem) {
    return gate12HealthCheckProblem;
  }

  const gate12RemoteSmokeProblem = gate12RemoteSmokeResultProblem(
    artifact,
    gateId,
    gate12RemoteSmokeResult,
  );
  if (gate12RemoteSmokeProblem) {
    return gate12RemoteSmokeProblem;
  }

  const gate12AuthModeProblem = gate12AuthModeDeployedProblem(
    artifact,
    gateId,
    gate12AuthModeDeployed,
  );
  if (gate12AuthModeProblem) {
    return gate12AuthModeProblem;
  }

  const gate12BudgetProblem = gate12BudgetGuardReviewProblem(
    artifact,
    gateId,
    gate12BudgetGuardReview,
  );
  if (gate12BudgetProblem) {
    return gate12BudgetProblem;
  }

  const gate12PathSecretProblem = gate12PathSecretReviewProblem(
    artifact,
    gateId,
    gate12PathSecretReview,
  );
  if (gate12PathSecretProblem) {
    return gate12PathSecretProblem;
  }

  const gate13SecretReferencesProblem = gate13SecretReferencesCheckedProblem(
    artifact,
    gateId,
    gate13SecretReferencesChecked,
  );
  if (gate13SecretReferencesProblem) {
    return gate13SecretReferencesProblem;
  }

  const gate13RequiredSecretNamesIssue = gate13RequiredSecretNamesProblem(
    artifact,
    gateId,
    gate13RequiredSecretNames,
  );
  if (gate13RequiredSecretNamesIssue) {
    return gate13RequiredSecretNamesIssue;
  }

  const gate13RuntimeServiceAccountIssue = gate13RuntimeServiceAccountProblem(
    artifact,
    gateId,
    gate13RuntimeServiceAccount,
  );
  if (gate13RuntimeServiceAccountIssue) {
    return gate13RuntimeServiceAccountIssue;
  }

  const gate13SecretAccessProblem = gate13SecretAccessBindingsProblem(
    artifact,
    gateId,
    gate13SecretAccessBindings,
  );
  if (gate13SecretAccessProblem) {
    return gate13SecretAccessProblem;
  }

  const gate13VersionProblem = gate13VersionPolicyProblem(
    artifact,
    gateId,
    gate13VersionPolicy,
  );
  if (gate13VersionProblem) {
    return gate13VersionProblem;
  }

  const gate13LiteralEnvProblem = gate13LiteralEnvReviewProblem(
    artifact,
    gateId,
    gate13LiteralEnvReview,
  );
  if (gate13LiteralEnvProblem) {
    return gate13LiteralEnvProblem;
  }

  const gate13SecretValueProblem = gate13SecretValueHandlingProblem(
    artifact,
    gateId,
    gate13SecretValueHandling,
  );
  if (gate13SecretValueProblem) {
    return gate13SecretValueProblem;
  }

  const gate13RotationProblem = gate13RotationFollowUpProblem(
    artifact,
    gateId,
    gate13RotationFollowUp,
  );
  if (gate13RotationProblem) {
    return gate13RotationProblem;
  }

  const gate14ClientProblem = gate14ClientTestedProblem(
    artifact,
    gateId,
    gate14ClientTested,
  );
  if (gate14ClientProblem) {
    return gate14ClientProblem;
  }

  const gate14EndpointProblem = gate14EndpointTestedProblem(
    artifact,
    gateId,
    gate14EndpointTested,
  );
  if (gate14EndpointProblem) {
    return gate14EndpointProblem;
  }

  const gate14HeaderProblem = gate14HeaderConfigurationMethodProblem(
    artifact,
    gateId,
    gate14HeaderConfigurationMethod,
  );
  if (gate14HeaderProblem) {
    return gate14HeaderProblem;
  }

  const gate14ToolListProblem = gate14ToolListResultProblem(
    artifact,
    gateId,
    gate14ToolListResult,
  );
  if (gate14ToolListProblem) {
    return gate14ToolListProblem;
  }

  const gate14ValidationProblem = gate14ValidationCallResultProblem(
    artifact,
    gateId,
    gate14ValidationCallResult,
  );
  if (gate14ValidationProblem) {
    return gate14ValidationProblem;
  }

  const gate14RejectionProblem = gate14RejectionProofProblem(
    artifact,
    gateId,
    gate14RejectionProof,
  );
  if (gate14RejectionProblem) {
    return gate14RejectionProblem;
  }

  const gate14TokenRedactionProblem = gate14TokenRedactionReviewProblem(
    artifact,
    gateId,
    gate14TokenRedactionReview,
  );
  if (gate14TokenRedactionProblem) {
    return gate14TokenRedactionProblem;
  }

  const gate15ClientProblem = gate15ClientTestedProblem(
    artifact,
    gateId,
    gate15ClientTested,
  );
  if (gate15ClientProblem) {
    return gate15ClientProblem;
  }

  const gate15ConfigProblem = gate15ConfigPathOrAddCommandProblem(
    artifact,
    gateId,
    gate15ConfigPathOrAddCommand,
  );
  if (gate15ConfigProblem) {
    return gate15ConfigProblem;
  }

  const gate15EntrypointProblem = gate15ServerEntrypointPathProblem(
    artifact,
    gateId,
    gate15ServerEntrypointPath,
  );
  if (gate15EntrypointProblem) {
    return gate15EntrypointProblem;
  }

  const gate15ToolListProblem = gate15ToolListResultProblem(
    artifact,
    gateId,
    gate15ToolListResult,
  );
  if (gate15ToolListProblem) {
    return gate15ToolListProblem;
  }

  const gate15ValidationProblem = gate15ValidationCallResultProblem(
    artifact,
    gateId,
    gate15ValidationCallResult,
  );
  if (gate15ValidationProblem) {
    return gate15ValidationProblem;
  }

  const gate15CredentialLocalityProblem = gate15CredentialLocalityReviewProblem(
    artifact,
    gateId,
    gate15CredentialLocalityReview,
  );
  if (gate15CredentialLocalityProblem) {
    return gate15CredentialLocalityProblem;
  }

  const gate16LogWindowProblem = gate16LogExportWindowProblem(
    artifact,
    gateId,
    gate16LogExportWindow,
  );
  if (gate16LogWindowProblem) {
    return gate16LogWindowProblem;
  }

  const gate16ServiceRevisionProblem = gate16CloudRunServiceRevisionProblem(
    artifact,
    gateId,
    gate16CloudRunServiceRevision,
  );
  if (gate16ServiceRevisionProblem) {
    return gate16ServiceRevisionProblem;
  }

  const gate16LiveTrafficProblem = gate16LiveTrafficExercisedProblem(
    artifact,
    gateId,
    gate16LiveTrafficExercised,
  );
  if (gate16LiveTrafficProblem) {
    return gate16LiveTrafficProblem;
  }

  const gate16ExportCommandProblem = gate16LogExportCommandProblem(
    artifact,
    gateId,
    gate16LogExportCommand,
  );
  if (gate16ExportCommandProblem) {
    return gate16ExportCommandProblem;
  }

  const gate16VerifierCommandFieldProblem = gate16VerifierCommandProblem(
    artifact,
    gateId,
    gate16VerifierCommand,
  );
  if (gate16VerifierCommandFieldProblem) {
    return gate16VerifierCommandFieldProblem;
  }

  const gate16AuditReviewProblem = gate16AuditEventReviewProblem(
    artifact,
    gateId,
    gate16AuditEventReview,
  );
  if (gate16AuditReviewProblem) {
    return gate16AuditReviewProblem;
  }

  const gate16FindingReviewFieldProblem = gate16FindingReviewProblem(
    artifact,
    gateId,
    gate16FindingReview,
  );
  if (gate16FindingReviewFieldProblem) {
    return gate16FindingReviewFieldProblem;
  }

  const gate16RawLogProblem = gate16RawLogHandlingProblem(
    artifact,
    gateId,
    gate16RawLogHandling,
  );
  if (gate16RawLogProblem) {
    return gate16RawLogProblem;
  }

  const gate16FollowUpProblem = gate16FollowUpActionProblem(
    artifact,
    gateId,
    gate16FollowUpAction,
  );
  if (gate16FollowUpProblem) {
    return gate16FollowUpProblem;
  }

  return undefined;
}

function gate7FixtureReadinessCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 7) {
    return undefined;
  }

  return /\bfixtures:status\b/iu.test(value) &&
    /(?:^|\s)--require-all(?:\s|$)/iu.test(value)
    ? undefined
    : `Gate 7 Fixture readiness command field must show fixtures:status ran with --require-all for the live fixture directory: ${artifact}.`;
}

function gate7FixtureCompatibilityCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 7) {
    return undefined;
  }

  const hasFixtureCompatibility =
    /\bsubstackFixtureCompatibility\.test\.ts\b/iu.test(value);
  const hasTestCommand = /\b(?:npm test|vitest|npm run test)\b/iu.test(value);

  return hasFixtureCompatibility && hasTestCommand
    ? undefined
    : `Gate 7 Fixture compatibility command field must show the Substack fixture compatibility test command: ${artifact}.`;
}

function gate7FixtureProvenanceProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 7) {
    return undefined;
  }

  if (!dryRunFixtureProvenancePattern().test(value)) {
    return undefined;
  }

  return `Gate 7 fixture provenance review describes dry-run output instead of live fixture capture or live editor review; run create:fixture with --kind all --capture or inspect live drafts before recording gate 7: ${artifact}.`;
}

function dryRunFixtureProvenancePattern(): RegExp {
  return /\b(?:dry run only|no live Substack fixture (?:was )?(?:created|captured)|no live Substack acceptance draft)\b/iu;
}

function gate7DraftUrlOrIdProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 7) {
    return undefined;
  }

  return hasSubstackDraftUrlOrNumericId(value)
    ? undefined
    : `Gate 7 Draft URL or ID field must include a Substack draft URL or numeric draft ID from the live acceptance draft: ${artifact}.`;
}

function gate8DraftUrlOrIdProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  return hasSubstackDraftUrlOrNumericId(value)
    ? undefined
    : `Gate 8 Draft URL or ID field must include a Substack draft URL or numeric draft ID from the live updated draft: ${artifact}.`;
}

function gate9DraftUrlOrIdReadProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return hasSubstackDraftUrlOrNumericId(value)
    ? undefined
    : `Gate 9 Draft URL or ID read field must include a Substack draft URL or numeric draft ID from the live read flow: ${artifact}.`;
}

function hasSubstackDraftUrlOrNumericId(value: string): boolean {
  return (
    /\bhttps:\/\/[^\s<>"'`]*substack[^\s<>"'`]*\/p\/[^\s<>"'`]+/iu.test(
      value,
    ) ||
    /\b(?:draft\s*)?(?:url\s*or\s*)?id\s*[:#]?\s*\d+\b/iu.test(value) ||
    /^\s*\d+\s*$/u.test(value)
  );
}

function gate7TitleSubtitleReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 7) {
    return undefined;
  }

  if (
    /\b(?:pending|todo|unknown|not checked|not reviewed|not compared)\b/iu.test(
      value,
    )
  ) {
    return `Gate 7 Title/subtitle review field must confirm the live draft title and subtitle matched the expected fixture values, or that no subtitle was expected: ${artifact}.`;
  }

  const hasTitle = /\btitle\b/iu.test(value);
  const hasSubtitle = /\bsubtitle\b/iu.test(value);
  const hasReview =
    /\b(?:matched|confirmed|reviewed|verified|correct|expected)\b/iu.test(
      value,
    );

  return hasTitle && hasSubtitle && hasReview
    ? undefined
    : `Gate 7 Title/subtitle review field must confirm the live draft title and subtitle matched the expected fixture values, or that no subtitle was expected: ${artifact}.`;
}

function gate7CleanupDecisionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  return liveDraftCleanupDecisionProblem(artifact, gateId, 7, value);
}

function gate8CleanupDecisionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  return liveDraftCleanupDecisionProblem(artifact, gateId, 8, value);
}

function liveDraftCleanupDecisionProblem(
  artifact: string,
  gateId: number,
  expectedGate: 7 | 8,
  value: string,
): string | undefined {
  if (gateId !== expectedGate) {
    return undefined;
  }

  const error = `Gate ${expectedGate} Cleanup decision field must record whether the live draft was kept, deleted, or left for further review, with no publish action: ${artifact}.`;

  if (
    /\b(?:pending|todo|unknown|not decided|left open|no decision)\b/iu.test(
      value,
    )
  ) {
    return error;
  }

  const hasDecision =
    /\b(?:kept|keep|retained|retain|deleted|delete|removed|remove|left|leave)\b/iu.test(
      value,
    );
  const hasDraftContext = /\b(?:draft|cleanup|review|manual|private)\b/iu.test(
    value,
  );
  const hasNoPublish =
    /\b(?:not published|never published|no publish|without publishing|unpublished|private)\b/iu.test(
      value,
    );

  return hasDecision && hasDraftContext && hasNoPublish ? undefined : error;
}

function gateDraftStatusProblem(
  artifact: string,
  gateId: number,
  field: "Unpublished status review" | "Unpublished status after update",
  value: string,
): string | undefined {
  const expectedGate = field === "Unpublished status review" ? 7 : 8;
  if (gateId !== expectedGate) {
    return undefined;
  }

  return !contradictoryDraftStatusPattern(value) &&
    unpublishedStatusPattern().test(value)
    ? undefined
    : `Gate ${gateId} ${field} field must confirm the Substack item remained unpublished; published/public status evidence does not satisfy gate ${gateId}: ${artifact}.`;
}

function contradictoryDraftStatusPattern(value: string): boolean {
  const safeNegationsRemoved = value
    .replace(/\bunpublished\b/giu, "")
    .replace(/\b(?:not|never|no)\s+(?:published|public|live)\b/giu, "")
    .replace(
      /\b(?:did not|never|not)\s+(?:go\s+|become\s+|be\s+)?(?:live|public|published)\b/giu,
      "",
    )
    .replace(/\bis[_ -]?published\s*[:=]\s*false\b/giu, "")
    .replace(/\bpublished\s*[:=]\s*false\b/giu, "");

  return (
    /\b(?:published|public|live)\b/iu.test(safeNegationsRemoved) ||
    /\b(?:not|no)\s+(?:a\s+)?draft\b/iu.test(value) ||
    /\bdraft\s*[:=]\s*false\b/iu.test(value) ||
    /\bis[_ -]?draft\s*[:=]\s*false\b/iu.test(value) ||
    /\bis[_ -]?published\s*[:=]\s*true\b/iu.test(value) ||
    /\bpublished\s*[:=]\s*true\b/iu.test(value)
  );
}

function unpublishedStatusPattern(): RegExp {
  return /\b(?:unpublished|stayed (?:a )?draft|remained (?:a )?draft|kept (?:as )?(?:a )?draft|left (?:as )?(?:a )?draft|status\s*[:=]\s*["']?(?:draft|unpublished)|is[_ -]?draft\s*[:=]\s*true|draft\s*[:=]\s*true|is[_ -]?published\s*[:=]\s*false|published\s*[:=]\s*false|not published|not public|not live|(?:did not|never|not)\s+(?:go\s+|become\s+|be\s+)?(?:live|public|published))\b/iu;
}

interface Gate7RichRenderingReviews {
  readonly gateId: number;
  readonly textFormattingReview: string;
  readonly imageRenderingReview: string;
  readonly nativeCodeBlockRenderingReview: string;
  readonly nativeLatexRenderingReview: string;
  readonly substackPreviewReview: string;
}

type Gate7RichRenderingField =
  | "Text formatting review"
  | "Image rendering review"
  | "Native code block rendering review"
  | "Native LaTeX rendering review"
  | "Substack preview review";

function gate7RichRenderingReviewProblem(
  artifact: string,
  reviews: Gate7RichRenderingReviews,
): string | undefined {
  if (reviews.gateId !== 7) {
    return undefined;
  }

  const fields: ReadonlyArray<{
    readonly field: Gate7RichRenderingField;
    readonly value: string;
    readonly expected: string;
  }> = [
    {
      field: "Text formatting review",
      value: reviews.textFormattingReview,
      expected: "successful Substack text formatting",
    },
    {
      field: "Image rendering review",
      value: reviews.imageRenderingReview,
      expected: "successful uploaded image rendering",
    },
    {
      field: "Native code block rendering review",
      value: reviews.nativeCodeBlockRenderingReview,
      expected: "successful native code block rendering",
    },
    {
      field: "Native LaTeX rendering review",
      value: reviews.nativeLatexRenderingReview,
      expected: "successful native LaTeX equation rendering",
    },
    {
      field: "Substack preview review",
      value: reviews.substackPreviewReview,
      expected: "successful Substack preview review",
    },
  ];

  for (const { field, value, expected } of fields) {
    if (
      richRenderingFailurePattern().test(stripSafeRichRenderingNegations(value))
    ) {
      return gate7RichRenderingReviewProblemMessage(artifact, field, expected);
    }

    if (!richRenderingSuccessPattern(field).test(value)) {
      return gate7RichRenderingReviewProblemMessage(artifact, field, expected);
    }
  }

  return undefined;
}

function gate7RichRenderingReviewProblemMessage(
  artifact: string,
  field: Gate7RichRenderingField,
  expected: string,
): string {
  return `Gate 7 ${field} field must confirm ${expected}; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: ${artifact}.`;
}

function richRenderingSuccessPattern(field: Gate7RichRenderingField): RegExp {
  const confirmation =
    "(?:confirmed|verified|reviewed|matched|rendered|displayed|appeared|passed|succeeded|correct|working)";
  switch (field) {
    case "Text formatting review":
      return new RegExp(
        `(?:\\b${confirmation}\\b.*\\b(?:text formatting|formatting|heading|rich text|link|list|blockquote|horizontal rule)\\b|\\b(?:text formatting|formatting|heading|rich text|link|list|blockquote|horizontal rule)\\b.*\\b${confirmation}\\b)`,
        "iu",
      );
    case "Image rendering review":
      return new RegExp(
        `(?:\\b${confirmation}\\b.*\\b(?:image|uploaded image|caption|alt text)\\b|\\b(?:image|uploaded image|caption|alt text)\\b.*\\b${confirmation}\\b)`,
        "iu",
      );
    case "Native code block rendering review":
      return new RegExp(
        `(?:\\b${confirmation}\\b.*\\b(?:native code block|code block|language formatting|syntax)\\b|\\b(?:native code block|code block|language formatting|syntax)\\b.*\\b${confirmation}\\b)`,
        "iu",
      );
    case "Native LaTeX rendering review":
      return new RegExp(
        `(?:\\b${confirmation}\\b.*\\b(?:native latex|latex|equation|math)\\b|\\b(?:native latex|latex|equation|math)\\b.*\\b${confirmation}\\b)`,
        "iu",
      );
    case "Substack preview review":
      return new RegExp(
        `(?:\\b${confirmation}\\b.*\\b(?:substack preview|preview)\\b|\\b(?:substack preview|preview)\\b.*\\b${confirmation}\\b)`,
        "iu",
      );
  }
}

function richRenderingFailurePattern(): RegExp {
  return /\b(?:failed|failure|missing|absent|broken|fallback|plain text|plain paragraph|plain url|raw markdown|raw latex|raw math|screenshot|unformatted|unstyled|not native|not rendered|not checked|not reviewed|not opened|unavailable|mismatch|did not render|did not match|not an? (?:native )?(?:code block|equation block|latex block))\b/iu;
}

function stripSafeRichRenderingNegations(value: string): string {
  return value
    .replace(
      /\b(?:no|not|never|without)\s+(?:raw markdown|raw latex|raw math|plain text|plain paragraph|plain url|fallback|screenshot|missing|absent|broken|failure|failed|unformatted|unstyled|mismatch|rendering problems?|issues?|problems?)\b/giu,
      "",
    )
    .replace(/\bdid not\s+(?:fail|fallback|fall back)\b/giu, "");
}

function gate8UpdatedTitleTransitionProblem(
  artifact: string,
  gateId: number,
  createdTitle: string,
  updatedTitle: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  return normalizeReviewValue(createdTitle) !==
    normalizeReviewValue(updatedTitle)
    ? undefined
    : `Gate 8 title fields must show a changed draft title before and after update; unchanged title evidence does not satisfy gate 8: ${artifact}.`;
}

function normalizeReviewValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function gate8UpdateCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  const guardedLiveSuite =
    /\bRUN_LIVE_SUBSTACK_TESTS\s*=\s*1\b/u.test(value) &&
    /\bnpm\s+run\s+test:live\b/iu.test(value);
  const explicitUpdateDraftFlow =
    /\bupdate_draft\b/iu.test(value) &&
    /\b(?:mcp|client|claude|cursor|chatgpt|manual|live|substack|tool|call|request|workflow)\b/iu.test(
      value,
    );
  const disallowed =
    /\b(?:pending|todo|unknown|not run|not executed|skipped|dry[- ]run|smoke[- ]only|local smoke|unit test|mock|mocked|fixture status|fixtures:status)\b/iu.test(
      value,
    );

  return !disallowed && (guardedLiveSuite || explicitUpdateDraftFlow)
    ? undefined
    : `Gate 8 Update command field must identify the guarded live update run or an explicit live update_draft MCP/client workflow; smoke-only, dry-run, mock, or generic test evidence does not satisfy gate 8: ${artifact}.`;
}

function gate8FieldUpdateReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  return !updateFailurePattern().test(stripSafeUpdateNegations(value)) &&
    updateSuccessPattern().test(value)
    ? undefined
    : `Gate 8 Field update review field must confirm at least one draft field changed successfully; failed, missing, or no-change evidence does not satisfy gate 8: ${artifact}.`;
}

function updateFailurePattern(): RegExp {
  return /\b(?:failed|failure|missing|not changed|no change|unchanged|not updated|did not update|rejected|rolled back|error)\b/iu;
}

function stripSafeUpdateNegations(value: string): string {
  return value
    .replace(
      /\b(?:no|not|without)\s+(?:failure|error|rollback|rejection)\b/giu,
      "",
    )
    .replace(/\bdid not\s+fail\b/giu, "");
}

function updateSuccessPattern(): RegExp {
  return /\b(?:changed|updated|applied|modified|succeeded|successful|transitioned)\b/iu;
}

function gate8PostUpdateGetDraftReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  return postUpdateReadbackPattern().test(value) &&
    !readbackMissingPattern().test(stripSafeReadbackNegations(value))
    ? undefined
    : `Gate 8 Post-update \`get_draft\` review field must confirm the updated draft was read back after the update; missing or stale readback evidence does not satisfy gate 8: ${artifact}.`;
}

function postUpdateReadbackPattern(): RegExp {
  return /\b(?:get_draft|read\s*back|readback|fetched|returned|verified|confirmed)\b.*\b(?:updated|post[- ]update|after update|new title|changed)\b|\b(?:updated|post[- ]update|after update|new title|changed)\b.*\b(?:get_draft|read\s*back|readback|fetched|returned|verified|confirmed)\b/iu;
}

function readbackMissingPattern(): RegExp {
  return /\b(?:not|no|missing|skipped|stale|old|before update|not read|not fetched|not verified|not confirmed)\b.*\b(?:get_draft|read\s*back|readback|fetch|verify|confirm|updated|post[- ]update)\b|\b(?:get_draft|read\s*back|readback|fetch|verify|confirm|updated|post[- ]update)\b.*\b(?:not|missing|skipped|stale|old)\b/iu;
}

function stripSafeReadbackNegations(value: string): string {
  return value.replace(
    /\bno\s+(?:stale|old|missing)\s+(?:readback|data|title)\b/giu,
    "",
  );
}

function gate8DraftBodyHandlingReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 8) {
    return undefined;
  }

  return rawBodySafeHandlingPattern().test(value) &&
    !rawBodyUnsafeHandlingPattern().test(stripSafeRawBodyNegations(value))
    ? undefined
    : `Gate 8 Draft body handling review field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: ${artifact}.`;
}

function gate9ListDraftsResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return readResultSuccessPattern().test(value) &&
    !readResultFailurePattern().test(value)
    ? undefined
    : `Gate 9 \`list_drafts\` result field must confirm the expected draft was listed, found, returned, included, or present: ${artifact}.`;
}

function gate9GetDraftResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return getDraftResultSuccessPattern().test(value) &&
    !readResultFailurePattern().test(value)
    ? undefined
    : `Gate 9 \`get_draft\` result field must confirm the expected draft metadata was fetched, read, returned, verified, or confirmed: ${artifact}.`;
}

function readResultSuccessPattern(): RegExp {
  return /\b(?:expected|target|created|updated)?\s*draft\b.*\b(?:listed|found|returned|included|present|appeared)\b|\b(?:listed|found|returned|included|present|appeared)\b.*\b(?:expected|target|created|updated)?\s*draft\b/iu;
}

function getDraftResultSuccessPattern(): RegExp {
  return /\b(?:expected|target|created|updated)?\s*draft\b.*\b(?:metadata|fetched|read|returned|verified|confirmed)\b|\b(?:metadata|fetched|read|returned|verified|confirmed)\b.*\b(?:expected|target|created|updated)?\s*draft\b/iu;
}

function readResultFailurePattern(): RegExp {
  return /\b(?:failed|failure|missing|not found|not returned|not listed|not present|empty|skipped|wrong|stale|error)\b/iu;
}

function gate9MetadataFieldsReviewedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return /\bid\b/iu.test(value) &&
    /\btitle\b/iu.test(value) &&
    /\b(?:url|status)\b/iu.test(value)
    ? undefined
    : `Gate 9 Metadata fields reviewed field must name id, title, and url or status metadata: ${artifact}.`;
}

function gate9BodyInclusionReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return bodyInclusionSafePattern().test(value) &&
    !bodyInclusionUnsafePattern().test(value)
    ? undefined
    : `Gate 9 Body inclusion review field must confirm draft body/content was not requested, not included, omitted, or metadata-only: ${artifact}.`;
}

function bodyInclusionSafePattern(): RegExp {
  return /\b(?:include_body\s*(?:remained|was|=|:)?\s*(?:false|off|0)|body (?:was )?(?:not requested|not included|omitted|excluded)|content (?:was )?(?:not requested|not included|omitted|excluded)|metadata[- ]only|without raw|no raw)\b/iu;
}

function bodyInclusionUnsafePattern(): RegExp {
  return /\b(?:include_body\s*(?:=|:|was)?\s*(?:true|on|1)|body (?:was )?(?:included|requested|returned|copied|recorded)|content (?:was )?(?:included|requested|returned|copied|recorded)|full body|full content|raw body|raw content)\b/iu;
}

function gate9PostUpdateReadbackReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return postUpdateReadbackPattern().test(value) &&
    !readbackMissingPattern().test(stripSafeReadbackNegations(value))
    ? undefined
    : `Gate 9 Post-update readback review field must confirm the updated draft was read back after the update; missing or stale readback evidence does not satisfy gate 9: ${artifact}.`;
}

function gate9RawBodyContentHandlingProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  return rawBodySafeHandlingPattern().test(value) &&
    !rawBodyUnsafeHandlingPattern().test(stripSafeRawBodyNegations(value))
    ? undefined
    : `Gate 9 Raw body/content handling field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: ${artifact}.`;
}

function gate9FollowUpActionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 9) {
    return undefined;
  }

  const rejected =
    /\b(?:pending|todo|unknown|not decided|not reviewed|left open|no decision)\b/iu.test(
      value,
    );
  const hasAction =
    /\b(?:no action|no follow[- ]?up|none needed|kept|deleted|left|cleanup|cleaned|retained|recapture|rerun|review|follow[- ]?up)\b/iu.test(
      value,
    );
  const hasReason =
    /\b(?:because|reason|after|since|metadata[- ]only|no raw|omitted|redacted|draft|review|cleanup|kept|deleted|unpublished|private|completed|not recorded)\b/iu.test(
      value,
    );

  return !rejected && hasAction && hasReason
    ? undefined
    : `Gate 9 Follow-up action field must record no-action reasoning, cleanup, or a concrete follow-up after the live read review: ${artifact}.`;
}

function rawBodySafeHandlingPattern(): RegExp {
  return /\b(?:redacted|omitted|not recorded|no raw|metadata[- ]only|excluded|without raw)\b/iu;
}

function rawBodyUnsafeHandlingPattern(): RegExp {
  const rawBodyObject =
    "(?:full\\s+)?(?:raw\\s+)?(?:draft\\s+)?(?:body\\/content|body\\s+content|body|content)";
  const unsafeVerb =
    "(?:included|requested|returned|copied|recorded|pasted|printed|captured|stored|logged|saved)";
  return new RegExp(
    `\\b(?:${rawBodyObject}\\s+(?:was\\s+)?${unsafeVerb}|${unsafeVerb}\\s+(?:the\\s+)?${rawBodyObject}|${rawBodyObject}\\s+(?:in|into|to|inside)\\s+(?:evidence|notes|appendix|artifact|log|logs|file|files))\\b`,
    "iu",
  );
}

function stripSafeRawBodyNegations(value: string): string {
  const rawBodyObject =
    "(?:full\\s+)?(?:raw\\s+)?(?:draft\\s+)?(?:body\\/content|body\\s+content|body|content)";
  const unsafeVerb =
    "(?:included|requested|returned|copied|recorded|pasted|printed|captured|stored|logged|saved)";
  return value
    .replace(
      new RegExp(
        `\\b(?:no|not|without)\\s+${rawBodyObject}\\s+(?:was\\s+)?${unsafeVerb}\\b`,
        "giu",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b${rawBodyObject}\\s+(?:was\\s+)?(?:not|never)\\s+${unsafeVerb}\\b`,
        "giu",
      ),
      "",
    );
}

function gate11ConnectorUrlProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 11 Connector URL field must identify the public HTTPS /mcp connector URL or a screenshot/reference that proves that URL: ${artifact}.`;
  }

  const hasHttpsMcpUrl =
    /\bhttps:\/\/[^\s<>"'`]+\/mcp(?:\/[^\s<>"'`]*)?\b/iu.test(value);
  const hasUrlReference =
    /\b(?:screenshot|screen shot|connector settings|connector registration|chatgpt connector)\b/iu.test(
      value,
    ) && /\b(?:https|\/mcp|url)\b/iu.test(value);

  return hasHttpsMcpUrl || hasUrlReference
    ? undefined
    : `Gate 11 Connector URL field must identify the public HTTPS /mcp connector URL or a screenshot/reference that proves that URL: ${artifact}.`;
}

function gate11ChatGptSurfaceTestedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (
    /\b(?:not ChatGPT|without ChatGPT|no ChatGPT|smoke[- ]only|local smoke|remote smoke only|not tested|pending|todo|not run)\b/iu.test(
      value,
    )
  ) {
    return `Gate 11 ChatGPT surface tested field must name ChatGPT; noauth smoke-only or other client evidence does not satisfy gate 11: ${artifact}.`;
  }

  return /\bchatgpt\b/iu.test(value)
    ? undefined
    : `Gate 11 ChatGPT surface tested field must name ChatGPT; noauth smoke-only or other client evidence does not satisfy gate 11: ${artifact}.`;
}

function gate11ToolListResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  const hasChatGptOrConnector = /\b(?:chatgpt|connector)\b/iu.test(value);

  return exactSevenToolListReviewPattern(value) && hasChatGptOrConnector
    ? undefined
    : `Gate 11 Tool-list result field must confirm the ChatGPT connector listed exactly the seven V1 draft-workflow tools: ${artifact}.`;
}

function gate11ManualFlowResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  const valueHasValidation = /\bvalidate(?:_newsletter_content)?\b/iu.test(
    value,
  );
  const valueHasPreview = /\bpreview(?:_draft)?\b/iu.test(value);
  const valueHasDraftWrite =
    /\b(?:create(?:_draft)?|created?|draft (?:created|creation)|confirmation token|write tool)\b/iu.test(
      value,
    );
  const valueIsSmokeOnly =
    /\b(?:smoke[- ]only|remote smoke only|local smoke only|without ChatGPT|not tested|pending|todo|not run)\b/iu.test(
      value,
    );

  return valueHasValidation &&
    valueHasPreview &&
    valueHasDraftWrite &&
    !valueIsSmokeOnly
    ? undefined
    : `Gate 11 Manual flow result field must confirm the ChatGPT connector completed validate, preview, and draft-creation steps; smoke-only or incomplete wording does not satisfy gate 11: ${artifact}.`;
}

function gate11DraftOrReviewReferenceProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (
    /\b(?:pending|todo|unknown|not recorded|not reviewed|local smoke|smoke artifact|no draft|no reference|none)\b/iu.test(
      value,
    )
  ) {
    return `Gate 11 Draft or review reference field must provide a non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference from the ChatGPT connector flow: ${artifact}.`;
  }

  const hasNonSensitiveReviewReference =
    /\b(?:screenshot|screen shot|manual review|review reference|chatgpt transcript|connector transcript|substack dashboard|draft review)\b/iu.test(
      value,
    ) &&
    !/\b(?:cookie|token|secret|raw body|full draft body|draft body)\b/iu.test(
      value,
    );

  return hasSubstackDraftUrlOrNumericId(value) || hasNonSensitiveReviewReference
    ? undefined
    : `Gate 11 Draft or review reference field must provide a non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference from the ChatGPT connector flow: ${artifact}.`;
}

function gate11TunnelExposureWindowProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (
    /\b(?:indefinite|left open|long[- ]lived|overnight|unknown|not recorded|not checked|pending|todo|still running)\b/iu.test(
      value,
    )
  ) {
    return `Gate 11 Tunnel exposure window field must give a bounded short-lived tunnel window with start/end times or a numeric duration: ${artifact}.`;
  }

  return boundedTunnelWindowPattern().test(value)
    ? undefined
    : `Gate 11 Tunnel exposure window field must give a bounded short-lived tunnel window with start/end times or a numeric duration: ${artifact}.`;
}

function boundedTunnelWindowPattern(): RegExp {
  return /\b(?:\d+\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours)|\d{4}-\d{2}-\d{2}T|from\b.+\bto\b|start(?:ed)?\b.+\bend(?:ed| time)?\b|duration)\b/isu;
}

function gate11UnexpectedTrafficReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (
    /\b(?:not checked|not reviewed|unknown|pending|todo|no logs|could not review|not available|skipped)\b/iu.test(
      value,
    )
  ) {
    return `Gate 11 Unexpected traffic review field must confirm ngrok or local traffic logs were reviewed and no unexpected traffic was observed or unresolved: ${artifact}.`;
  }

  const hasReviewedTrafficSource = reviewedTrafficSourcePattern().test(value);
  const hasCleanOrResolvedOutcome =
    noUnexpectedTrafficPattern().test(value) ||
    reviewedUnexpectedTrafficPattern().test(value);

  return hasReviewedTrafficSource && hasCleanOrResolvedOutcome
    ? undefined
    : `Gate 11 Unexpected traffic review field must confirm ngrok or local traffic logs were reviewed and no unexpected traffic was observed or unresolved: ${artifact}.`;
}

function noUnexpectedTrafficPattern(): RegExp {
  return /\bno unexpected (?:traffic|requests|access|hits)\b/iu;
}

function reviewedTrafficSourcePattern(): RegExp {
  return /\b(?:ngrok|local|server|traffic|request|access|logs?)\b.{0,120}\b(?:reviewed|checked|inspected)\b|\b(?:reviewed|checked|inspected)\b.{0,120}\b(?:ngrok|local|server|traffic|request|access|logs?)\b/isu;
}

function reviewedUnexpectedTrafficPattern(): RegExp {
  return /\b(?:ngrok|local|server|traffic|request|access|logs?)\b.*\b(?:reviewed|checked|inspected)\b.*\b(?:none|no unexpected|benign|explained|handled|blocked|resolved)\b/isu;
}

function gate11RotationDecisionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 11) {
    return undefined;
  }

  if (
    /\b(?:pending|todo|unknown|not checked|not decided|left open|no decision)\b/iu.test(
      value,
    )
  ) {
    return `Gate 11 Rotation decision field must record whether credentials or the tunnel were rotated, stopped, revoked, or intentionally not rotated with a reason: ${artifact}.`;
  }

  if (unsafeNoRotationAfterExposurePattern(value)) {
    return `Gate 11 Rotation decision field must record whether credentials or the tunnel were rotated, stopped, revoked, or intentionally not rotated with a reason: ${artifact}.`;
  }

  const hasDecision =
    /\b(?:rotated|rotation|not rotated|no rotation|revoked|invalidated|stopped|closed|ended)\b/iu.test(
      value,
    );
  const hasReason =
    /\b(?:because|reason|only|after|tunnel|session|token|credential|synthetic|no secret|no credential|not exposed|stopped|closed|ended)\b/iu.test(
      value,
    );

  return hasDecision && hasReason
    ? undefined
    : `Gate 11 Rotation decision field must record whether credentials or the tunnel were rotated, stopped, revoked, or intentionally not rotated with a reason: ${artifact}.`;
}

function gate12GcpProjectRegionServiceProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 GCP project/region/service field must identify the deployed project, region, and Cloud Run service: ${artifact}.`;
  }

  const hasProject = /\b(?:project|gcp|google cloud)\b/iu.test(value);
  const hasRegion =
    /\b[a-z]+-[a-z0-9]+-\d+\b/iu.test(value) || /\bregion\b/iu.test(value);
  const hasService = /\b(?:service|cloud run|run service)\b/iu.test(value);

  return hasProject && hasRegion && hasService
    ? undefined
    : `Gate 12 GCP project/region/service field must identify the deployed project, region, and Cloud Run service: ${artifact}.`;
}

function gate12ServiceUrlCheckedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 Service URL checked field must include the deployed HTTPS service URL or equivalent checked URL reference: ${artifact}.`;
  }

  const hasHttpsUrl = /\bhttps:\/\/[^\s<>"'`]+/iu.test(value);
  const hasServiceContext =
    /\b(?:cloud run|run\.app|service url|deployed|mcp|healthz)\b/iu.test(value);

  return hasHttpsUrl && hasServiceContext
    ? undefined
    : `Gate 12 Service URL checked field must include the deployed HTTPS service URL or equivalent checked URL reference: ${artifact}.`;
}

function gate12DeployCommandSourceProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 Deploy command source field must reference the cloud-run:plan artifact or the gcloud run deploy command source: ${artifact}.`;
  }

  return /\b(?:cloud-run:plan|cloud run plan|gcloud run deploy|deploy command|deployment command|plan artifact)\b/iu.test(
    value,
  )
    ? undefined
    : `Gate 12 Deploy command source field must reference the cloud-run:plan artifact or the gcloud run deploy command source: ${artifact}.`;
}

function gate12HealthCheckResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 Health check result field must confirm /healthz succeeded on the deployed service: ${artifact}.`;
  }

  const hasHealthz = /\/healthz\b/iu.test(value);
  const hasSuccess =
    /\b(?:200|2xx|ok|passed|success|succeeded|healthy)\b/iu.test(value);

  return hasHealthz && hasSuccess
    ? undefined
    : `Gate 12 Health check result field must confirm /healthz succeeded on the deployed service: ${artifact}.`;
}

function gate12RemoteSmokeResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 Remote smoke result field must confirm an auth-mode matching remote MCP smoke passed against the deployed service URL: ${artifact}.`;
  }

  const hasRemoteSmoke =
    /\b(?:remote smoke|smoke:remote|smoke:remote-noauth|smoke:remote-oauth|smoke:remote-http|smoke test|MCP smoke|mcp session)\b/iu.test(
      value,
    );
  const hasSuccess = /\b(?:passed|success|succeeded|completed|ok)\b/iu.test(
    value,
  );
  const hasAuthModeProof =
    /\b(?:auth[- ]mode matching|matching auth[- ]mode|AUTH_MODE|noauth|static[_ -]bearer|oauth|bearer|MCP_BEARER_TOKEN|Authorization)\b/iu.test(
      value,
    ) ||
    /\bsmoke:(?:remote-noauth|remote-oauth|ngrok-noauth|ngrok-static-bearer|ngrok-oauth)\b/iu.test(
      value,
    );

  return hasRemoteSmoke && hasSuccess && hasAuthModeProof
    ? undefined
    : `Gate 12 Remote smoke result field must confirm an auth-mode matching remote MCP smoke passed against the deployed service URL: ${artifact}.`;
}

function gate12AuthModeDeployedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  return /\b(?:noauth|static[_ -]bearer|oauth)\b/iu.test(value)
    ? undefined
    : `Gate 12 Auth mode deployed field must name one supported app auth mode: noauth, static_bearer, or oauth: ${artifact}.`;
}

function gate12BudgetGuardReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  return !budgetGuardMissingPattern().test(value) &&
    budgetGuardReviewPattern().test(value)
    ? undefined
    : `Gate 12 Budget guard review field must confirm a Cloud Billing budget alert command/result, or an explicit budget-alert follow-up/decision: ${artifact}.`;
}

function gate12PathSecretReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 12) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 12 Path-secret review field must state MCP_PATH_SECRET was not used or that the private path segment was verified without recording its value: ${artifact}.`;
  }

  if (
    sensitiveValueUnsafeHandlingPattern(value, pathSecretValueSubjectPattern())
  ) {
    return `Gate 12 Path-secret review field must state MCP_PATH_SECRET was not used or that the private path segment was verified without recording its value: ${artifact}.`;
  }

  const saysNotUsed =
    /\b(?:not used|unused|disabled|absent|no mcp_path_secret|no path secret|no private path)\b/iu.test(
      value,
    );
  const saysUsedSafely =
    /\b(?:mcp_path_secret|path secret|private path|path segment)\b/iu.test(
      value,
    ) &&
    /\b(?:shell-only|not recorded|without recording|without the segment value|redacted|value omitted|segment omitted|not pasted|not exposed)\b/iu.test(
      value,
    );

  return saysNotUsed || saysUsedSafely
    ? undefined
    : `Gate 12 Path-secret review field must state MCP_PATH_SECRET was not used or that the private path segment was verified without recording its value: ${artifact}.`;
}

function pathSecretValueSubjectPattern(): string {
  return String.raw`MCP_PATH_SECRET|path\s+secrets?|private\s+paths?|private\s+path\s+segments?|path\s+segments?|segment\s+values?`;
}

function incompleteReviewPattern(): RegExp {
  return /\b(?:pending|todo|unknown|not checked|not reviewed|not run|skipped|missing|n\/a|tbd)\b/iu;
}

function budgetGuardMissingPattern(): RegExp {
  return /\b(?:no|not|without|missing|skipped|absent|none)\b.*\b(?:budget|billing)\b.*\b(?:alert|guard)\b|\b(?:budget|billing)\b.*\b(?:alert|guard)\b.*\b(?:not|missing|skipped|absent|none)\b/iu;
}

function budgetGuardReviewPattern(): RegExp {
  return /\b(?:budget|billing)\b.*\b(?:alert|guard|follow[- ]?up|command|created|configured|verified|reviewed|5usd|\$5)\b|\b(?:alert|guard|follow[- ]?up|command|created|configured|verified|reviewed)\b.*\b(?:budget|billing)\b/iu;
}

function gate13SecretReferencesCheckedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  return secretManagerReferencePattern().test(value) &&
    requiredAlwaysSecretEnvNamesPattern().test(value)
    ? undefined
    : `Gate 13 Secret references checked field must confirm Secret Manager references for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET: ${artifact}.`;
}

function secretManagerReferencePattern(): RegExp {
  return /\b(?:secret manager|secretmanager|secret references?|secret env|secretkeyref|valuefrom|secret refs?)\b/iu;
}

function requiredAlwaysSecretEnvNamesPattern(): RegExp {
  return /\bSUBSTACK_SESSION_TOKEN\b[\s\S]*\bPREVIEW_TOKEN_SECRET\b|\bPREVIEW_TOKEN_SECRET\b[\s\S]*\bSUBSTACK_SESSION_TOKEN\b/iu;
}

function gate13RequiredSecretNamesProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  if (
    /\b(?:not recorded|not listed|unknown|pending|todo|missing)\b/iu.test(value)
  ) {
    return `Gate 13 Required secret names field must list Secret Manager resource names for the session and preview-token secrets without secret values: ${artifact}.`;
  }

  const valueNamesSessionSecret = /\b(?:substack|session|cookie)\b/iu.test(
    value,
  );
  const valueNamesPreviewSecret = /\bpreview\b/iu.test(value);
  const valueNamesSecretResource =
    /\b(?:secret|secret manager|projects\/[^/\s]+\/secrets\/|:latest)\b/iu.test(
      value,
    );

  return valueNamesSessionSecret &&
    valueNamesPreviewSecret &&
    valueNamesSecretResource
    ? undefined
    : `Gate 13 Required secret names field must list Secret Manager resource names for the session and preview-token secrets without secret values: ${artifact}.`;
}

function gate13RuntimeServiceAccountProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  return /\b(?:service account|runtime identity|run\.app|iam\.gserviceaccount\.com)\b/iu.test(
    value,
  )
    ? undefined
    : `Gate 13 Runtime service account field must identify the deployed runtime service account or service identity: ${artifact}.`;
}

function gate13SecretAccessBindingsProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  if (negativeSecretAccessBindingPattern().test(value)) {
    return `Gate 13 Secret access bindings field must confirm the runtime service account has Secret Manager Secret Accessor bindings: ${artifact}.`;
  }

  const valueHasServiceAccount =
    /\b(?:service account|iam\.gserviceaccount\.com|runtime identity)\b/iu.test(
      value,
    );
  const valueHasSecretAccessor =
    /\b(?:secret accessor|secretmanager\.secretAccessor|roles\/secretmanager\.secretAccessor|secret-access)\b/iu.test(
      value,
    );
  const valueConfirmed =
    /\b(?:confirmed|verified|granted|bound|binding|iam)\b/iu.test(value);

  return valueHasServiceAccount && valueHasSecretAccessor && valueConfirmed
    ? undefined
    : `Gate 13 Secret access bindings field must confirm the runtime service account has Secret Manager Secret Accessor bindings: ${artifact}.`;
}

function negativeSecretAccessBindingPattern(): RegExp {
  return /\b(?:no|without|missing|not)\b.{0,80}\b(?:secret accessor|secretmanager\.secretAccessor|roles\/secretmanager\.secretAccessor|secret-access|binding|iam)\b|\b(?:secret accessor|secretmanager\.secretAccessor|roles\/secretmanager\.secretAccessor|secret-access|binding|iam)\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:verified|granted|bound|configured|present)\b|\b(?:pending|todo|not verified|not granted|not bound|not configured|not present)\b/isu;
}

function gate13VersionPolicyProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  if (/\b(?:unknown|pending|todo|not decided|not reviewed)\b/iu.test(value)) {
    return `Gate 13 Version policy field must record latest/pinned version usage and rotation notes: ${artifact}.`;
  }

  return /\b(?:latest|pinned|specific version|version \d+|:[a-z0-9_.-]+)\b[\s\S]*\b(?:rotation|rotate|redeploy|rollout)\b|\b(?:rotation|rotate|redeploy|rollout)\b[\s\S]*\b(?:latest|pinned|specific version|version \d+|:[a-z0-9_.-]+)\b/iu.test(
    value,
  )
    ? undefined
    : `Gate 13 Version policy field must record latest/pinned version usage and rotation notes: ${artifact}.`;
}

function gate13LiteralEnvReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  return literalEnvReviewSafePattern().test(value)
    ? undefined
    : `Gate 13 Literal env review field must confirm secrets are Secret Manager references, not literal environment values: ${artifact}.`;
}

function literalEnvReviewSafePattern(): RegExp {
  return /\b(?:secret manager|secretmanager|secret references?|references?|secretkeyref|valuefrom)\b.*\b(?:no|not|without|absent|none)\b.*\b(?:literal|raw|plaintext|plain text|env(?:ironment)? values?)\b|\b(?:no|not|without|absent|none)\b.*\b(?:literal|raw|plaintext|plain text|env(?:ironment)? values?)\b.*\b(?:secret manager|secretmanager|secret references?|references?|secretkeyref|valuefrom)\b/iu;
}

function gate13SecretValueHandlingProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  return secretValueHandlingSafePattern().test(value) &&
    !sensitiveValueUnsafeHandlingPattern(value, rawSecretValueSubjectPattern())
    ? undefined
    : `Gate 13 Secret value handling field must confirm no raw secret values were opened, pasted, exposed, or recorded: ${artifact}.`;
}

function secretValueHandlingSafePattern(): RegExp {
  return /\b(?:no|not|never|without)\b.*\b(?:raw\s+)?secret values?\b.*\b(?:opened|pasted|exposed|recorded|printed|copied|viewed|included|read)\b|\b(?:raw\s+)?secret values?\b.*\b(?:not|never)\b.*\b(?:opened|pasted|exposed|recorded|printed|copied|viewed|included|read)\b/iu;
}

function rawSecretValueSubjectPattern(): string {
  return String.raw`(?:raw\s+)?secret values?`;
}

function gate13RotationFollowUpProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 13) {
    return undefined;
  }

  if (/\b(?:unknown|pending|todo|not decided|not reviewed)\b/iu.test(value)) {
    return `Gate 13 Rotation follow-up field must record no-action reasoning or the rotation/redeploy follow-up: ${artifact}.`;
  }

  if (unsafeNoRotationAfterExposurePattern(value)) {
    return `Gate 13 Rotation follow-up field must record no-action reasoning or the rotation/redeploy follow-up: ${artifact}.`;
  }

  return /\b(?:no action|no rotation|not rotated|rotate|rotated|rotation|redeploy|re-deploy|rollout)\b[\s\S]*\b(?:because|reason|after|follow[- ]?up|scheduled|completed|secret|credential|exposed|not exposed|no raw)\b/iu.test(
    value,
  )
    ? undefined
    : `Gate 13 Rotation follow-up field must record no-action reasoning or the rotation/redeploy follow-up: ${artifact}.`;
}

function unsafeNoRotationAfterExposurePattern(value: string): boolean {
  const safeNegationsRemoved = value
    .replace(
      /\b(?:no|not|never|without)\s+(?:raw\s+)?(?:credential|credentials|token|tokens|secret|secrets|secret values?|session|sessions|cookie|cookies)\b.{0,50}\b(?:exposed|exposure|leaked|leak|shared|recorded|pasted|printed|logged)\b/giu,
      "",
    )
    .replace(
      /\b(?:raw\s+)?(?:credential|credentials|token|tokens|secret|secrets|secret values?|session|sessions|cookie|cookies)\b.{0,50}\b(?:not|never)\b.{0,50}\b(?:exposed|exposure|leaked|leak|shared|recorded|pasted|printed|logged)\b/giu,
      "",
    )
    .replace(
      /\bno\s+(?:unexpected|unresolved)\s+(?:traffic|requests?|access|hits)\b/giu,
      "",
    );

  return /\b(?:no action|no rotation|not rotated|none needed)\b(?=[\s\S]*\b(?:credential|credentials|token|tokens|secret|secrets|session|sessions|cookie|cookies|unexpected traffic|unexpected requests?|unresolved traffic|unresolved requests?)\b)(?=[\s\S]*\b(?:exposed|exposure|leaked|leak|shared|recorded|pasted|printed|logged|unresolved|unexpected)\b)/iu.test(
    safeNegationsRemoved,
  );
}

function gate14ClientTestedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  if (
    /\b(?:smoke[- ]only|local smoke only|remote smoke only|not tested|pending|todo|not run)\b/iu.test(
      value,
    )
  ) {
    return `Gate 14 client tested field must name a real header-capable HTTP client, not smoke-only or pending evidence: ${artifact}.`;
  }

  return headerCapableHttpClientPattern().test(value)
    ? undefined
    : `Gate 14 client tested field must name a real header-capable HTTP client, not smoke-only or pending evidence: ${artifact}.`;
}

function headerCapableHttpClientPattern(): RegExp {
  return /\b(?:curl|httpie|postman|insomnia|bruno|hoppscotch|thunder client|rest client|http client|header-capable|header capable|claude code|cursor)\b/iu;
}

function gate14EndpointTestedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 14 Endpoint tested field must identify the public HTTPS /mcp endpoint tested through the header-capable client: ${artifact}.`;
  }

  return publicHttpsMcpEndpointReferencePattern().test(value)
    ? undefined
    : `Gate 14 Endpoint tested field must identify the public HTTPS /mcp endpoint tested through the header-capable client: ${artifact}.`;
}

function publicHttpsMcpEndpointReferencePattern(): RegExp {
  return /\bhttps:\/\/[^\s<>"'`]*\/mcp(?:\/[^\s<>"'`]*)?\b|\b(?:screenshot|screen shot|client config|request log|endpoint reference|url reference)\b[\s\S]*\bhttps\b[\s\S]*\b\/mcp\b/iu;
}

function gate14HeaderConfigurationMethodProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  if (negativeAuthorizationHeaderPattern().test(value)) {
    return `Gate 14 header configuration method must describe an Authorization header; smoke-only or token-free wording does not satisfy gate 14: ${artifact}.`;
  }

  return /\bauthorization\b/iu.test(value) && /\bheader\b/iu.test(value)
    ? undefined
    : `Gate 14 header configuration method must describe an Authorization header; smoke-only or token-free wording does not satisfy gate 14: ${artifact}.`;
}

function negativeAuthorizationHeaderPattern(): RegExp {
  return /\b(?:no|without)\s+authorization\s+header\b|\bauthorization\s+header\b.{0,60}\b(?:not|never)\b.{0,40}\b(?:configured|set|sent|used)\b|\b(?:not|never)\b.{0,40}\b(?:configured|set|sent|used)\b.{0,60}\bauthorization\s+header\b|\b(?:token[- ]free|smoke[- ]only|not tested|pending|todo|not run)\b/isu;
}

function gate14ToolListResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  return exactSevenToolListReviewPattern(value)
    ? undefined
    : `Gate 14 Tool-list result field must confirm the header-capable client listed exactly the seven V1 draft-workflow tools: ${artifact}.`;
}

function exactSevenToolListPattern(): RegExp {
  return /^(?=.*\b(?:exactly\s+)?(?:seven|7)\b)(?=.*\bV1\b)(?=.*\bdraft[- ]workflow\b)(?=.*\btools?\b)(?=.*\b(?:listed|returned|shown|available|visible)\b).+$/isu;
}

function exactSevenToolListReviewPattern(value: string): boolean {
  return (
    exactSevenToolListPattern().test(value) &&
    !contradictoryToolCountPattern().test(value)
  );
}

function contradictoryToolCountPattern(): RegExp {
  return /\b(?:not|never)\s+(?:exactly\s+)?(?:seven|7)\b.{0,80}\btools?\b|\btools?\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:exactly\s+)?(?:seven|7)\b|\b(?:more|fewer|less)\s+than\s+(?:seven|7)\b.{0,80}\btools?\b|\b(?:only\s+)?(?:zero|one|two|three|four|five|six|eight|nine|ten|eleven|twelve|0|1|2|3|4|5|6|8|9|1\d|[2-9]\d)\s+(?:V1\s+|draft-workflow\s+)?tools?\b|\btool count:\s*(?:0|1|2|3|4|5|6|8|9|1\d|[2-9]\d)\b/iu;
}

function gate14ValidationCallResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  return validationSucceededPattern().test(value)
    ? undefined
    : `Gate 14 Validation call result field must confirm validate_newsletter_content succeeded through the header-capable client: ${artifact}.`;
}

function validationSucceededPattern(): RegExp {
  return /\bvalidate(?:_newsletter_content)?\b.*\b(?:succeeded|passed|completed|ok|success|returned)\b/iu;
}

function gate14RejectionProofProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  const valueHasMissingBearer =
    /\bmissing\b.*\b(?:bearer|token|auth|authorization)\b/iu.test(value);
  const valueHasWrongBearer =
    /\b(?:wrong|invalid|bad)\b.*\b(?:bearer|token|auth|authorization)\b/iu.test(
      value,
    );
  const valueHasUnauthorized = /\b401\b|\bunauthori[sz]ed\b/iu.test(value);

  return valueHasMissingBearer && valueHasWrongBearer && valueHasUnauthorized
    ? undefined
    : `Gate 14 Rejection proof field must confirm missing and wrong bearer credentials were rejected with HTTP 401 or unauthorized responses: ${artifact}.`;
}

function gate14TokenRedactionReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 14) {
    return undefined;
  }

  if (
    /\b(?:not checked|not reviewed|unknown|pending|todo|token included|token recorded|token printed|token pasted|token exposed)\b/iu.test(
      value,
    ) ||
    sensitiveValueUnsafeHandlingPattern(value, bearerTokenSubjectPattern())
  ) {
    return `Gate 14 Token redaction review field must confirm no bearer token or token value was included, recorded, printed, pasted, exposed, or logged: ${artifact}.`;
  }

  return tokenRedactionSafePattern().test(value)
    ? undefined
    : `Gate 14 Token redaction review field must confirm no bearer token or token value was included, recorded, printed, pasted, exposed, or logged: ${artifact}.`;
}

function tokenRedactionSafePattern(): RegExp {
  return /\b(?:no|not|never|without)\b.*\b(?:bearer\s+token|token\s+value|raw\s+token|secret\s+token)\b.*\b(?:included|recorded|printed|pasted|exposed|logged|shown|stored|copied)\b|\b(?:bearer\s+token|token\s+value|raw\s+token|secret\s+token)\b.*\b(?:not|never)\b.*\b(?:included|recorded|printed|pasted|exposed|logged|shown|stored|copied)\b/iu;
}

function bearerTokenSubjectPattern(): string {
  return String.raw`(?:bearer\s+tokens?|token\s+values?|raw\s+tokens?|secret\s+tokens?)`;
}

function gate15ClientTestedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  if (negativeStdioClientTestedPattern().test(value)) {
    return `Gate 15 client tested field must name Claude Code or Cursor; smoke-only or other client evidence does not satisfy gate 15: ${artifact}.`;
  }

  return /\b(?:claude code|cursor)\b/iu.test(value)
    ? undefined
    : `Gate 15 client tested field must name Claude Code or Cursor; smoke-only or other client evidence does not satisfy gate 15: ${artifact}.`;
}

function negativeStdioClientTestedPattern(): RegExp {
  return /\b(?:not|without|no)\s+(?:claude code|cursor)\b|\b(?:claude code|cursor)\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:tested|connected|used|configured)\b|\b(?:not|never)\b.{0,40}\b(?:tested|connected|used|configured)\b.{0,80}\b(?:claude code|cursor)\b|\b(?:smoke[- ]only|local smoke only|remote smoke only|not tested|pending|todo|not run|mcp inspector only)\b/isu;
}

function gate15ConfigPathOrAddCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  if (
    incompleteReviewPattern().test(value) ||
    /\b(?:smoke[- ]only|local smoke only|not configured|not added|not installed)\b/iu.test(
      value,
    )
  ) {
    return `Gate 15 Config path or add command field must identify the Claude Code/Cursor stdio config path or add command used for the client: ${artifact}.`;
  }

  return stdioClientConfigReferencePattern().test(value)
    ? undefined
    : `Gate 15 Config path or add command field must identify the Claude Code/Cursor stdio config path or add command used for the client: ${artifact}.`;
}

function stdioClientConfigReferencePattern(): RegExp {
  return /\bclaude\s+mcp\s+add(?:-json)?\b[\s\S]*\b(?:stdio|dist[\\/]stdio\.js|node)\b|\bcursor\b[\s\S]*\b(?:mcp\.json|settings\.json|stdio|dist[\\/]stdio\.js)\b|(?:^|[\s`'"])(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])?(?:\.cursor[\\/]mcp\.json|\.cursor[\\/]settings\.json|mcp\.json|settings\.json)\b[\s\S]*\b(?:stdio|dist[\\/]stdio\.js|claude code|cursor)\b|\b(?:config path|configuration path|add command)\b[\s\S]*\b(?:stdio|dist[\\/]stdio\.js|claude code|cursor)\b/iu;
}

function gate15ServerEntrypointPathProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  return absoluteStdioEntrypointPathPattern().test(value)
    ? undefined
    : `Gate 15 Server entrypoint path field must identify an absolute path to dist/stdio.js for the built stdio package: ${artifact}.`;
}

function absoluteStdioEntrypointPathPattern(): RegExp {
  return /(?:^|[\s`'"])(?:\/|[A-Za-z]:[\\/])(?:[^\s`'"]+[\\/])*dist[\\/]stdio\.js\b/iu;
}

function gate15ToolListResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  return exactSevenToolListReviewPattern(value)
    ? undefined
    : `Gate 15 Tool-list result field must confirm Claude Code or Cursor listed exactly the seven V1 draft-workflow tools: ${artifact}.`;
}

function gate15ValidationCallResultProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  return validationSucceededPattern().test(value)
    ? undefined
    : `Gate 15 Validation call result field must confirm validate_newsletter_content succeeded through Claude Code or Cursor: ${artifact}.`;
}

function gate15CredentialLocalityReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 15) {
    return undefined;
  }

  if (
    /\b(?:not checked|not reviewed|unknown|pending|todo|remote host|checked into|committed to|raw secret|token value recorded|credential value recorded)\b/iu.test(
      value,
    ) ||
    sensitiveValueUnsafeHandlingPattern(value, credentialSubjectPattern())
  ) {
    return `Gate 15 Credential locality review field must confirm Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely: ${artifact}.`;
  }

  const valueHasCredential =
    /\b(?:credentials?|substack|session token|cookie|secret|env(?:ironment)?(?: variables?)?)\b/iu.test(
      value,
    );
  const valueHasLocalEnv =
    /\b(?:local|env(?:ironment)?(?: variables?)?|process env|machine-local)\b/iu.test(
      value,
    );
  const valueHasNoExposure =
    /\b(?:no|not|never|without)\b.*\b(?:recorded|committed|pasted|exposed|stored|printed|logged|remote|repo|repository|client config)\b/iu.test(
      value,
    ) ||
    /\b(?:recorded|committed|pasted|exposed|stored|printed|logged|remote|repo|repository|client config)\b.*\b(?:no|not|never)\b/iu.test(
      value,
    );

  return valueHasCredential && valueHasLocalEnv && valueHasNoExposure
    ? undefined
    : `Gate 15 Credential locality review field must confirm Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely: ${artifact}.`;
}

function credentialSubjectPattern(): string {
  return String.raw`(?:substack\s+)?credentials?|credential\s+values?|session\s+tokens?|cookies?|secrets?|SUBSTACK_SESSION_TOKEN|PREVIEW_TOKEN_SECRET|MCP_BEARER_TOKEN`;
}

function oauthTokenSubjectPattern(): string {
  return String.raw`(?:oauth\s+)?tokens?|token\s+values?|authorization\s+codes?|code\s+values?|credentials?|credential\s+values?|secrets?|secret\s+values?`;
}

function sensitiveValueUnsafeHandlingPattern(
  value: string,
  subjectPattern: string,
): boolean {
  const unsafeVerb =
    "(?:included|recorded|printed|pasted|exposed|logged|shown|stored|copied|opened|viewed|read|committed)";
  const unsafeSubjectPattern = String.raw`\b(?:${subjectPattern})\b.{0,120}\b${unsafeVerb}\b|\b${unsafeVerb}\b.{0,120}\b(?:${subjectPattern})\b|\b(?:${subjectPattern})\b.{0,120}\b(?:in|into|to|inside)\s+(?:evidence|notes|appendix|artifact|log|logs|file|files|config|client config|client configuration)\b`;
  if (
    new RegExp(
      String.raw`\b(?:but|however|except|although)\b.{0,180}(?:${unsafeSubjectPattern})`,
      "isu",
    ).test(value)
  ) {
    return true;
  }

  const safeNegationsRemoved = value
    .replace(
      new RegExp(
        String.raw`\b(?:no|not|never|without)\s+${subjectPattern}\b[^.;,\n]{0,80}\b${unsafeVerb}\b`,
        "giu",
      ),
      "",
    )
    .replace(
      new RegExp(
        String.raw`\b${subjectPattern}\b[^.;,\n]{0,80}\b(?:not|never)\b[^.;,\n]{0,80}\b${unsafeVerb}\b`,
        "giu",
      ),
      "",
    );

  return new RegExp(unsafeSubjectPattern, "isu").test(safeNegationsRemoved);
}

function gate16LogExportWindowProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Log export window field must include the live Cloud Run log export start/end time or query window: ${artifact}.`;
  }

  const hasTimeReference =
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/iu.test(value) ||
    /\b(?:last|previous)\s+\d+\s+(?:minutes?|hours?)\b/iu.test(value);
  const hasWindowReference =
    /\b(?:to|through|until|between|from|since|window|start|end|last|previous)\b/iu.test(
      value,
    );

  return hasTimeReference && hasWindowReference
    ? undefined
    : `Gate 16 Log export window field must include the live Cloud Run log export start/end time or query window: ${artifact}.`;
}

function gate16CloudRunServiceRevisionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Cloud Run service/revision field must identify the Cloud Run service and revision or service URL used for the log export: ${artifact}.`;
  }

  const hasCloudRunService =
    /\b(?:cloud run|run\.app|service)\b/iu.test(value) ||
    /\b[a-z][a-z0-9-]+\/[a-z][a-z0-9-]*revision[a-z0-9-]*\b/iu.test(value);
  const hasRevisionOrUrl =
    /\b(?:revision|rev|run\.app)\b/iu.test(value) ||
    /\bhttps:\/\/[^\s<>"'`]+/iu.test(value);

  return hasCloudRunService && hasRevisionOrUrl
    ? undefined
    : `Gate 16 Cloud Run service/revision field must identify the Cloud Run service and revision or service URL used for the log export: ${artifact}.`;
}

function gate16LiveTrafficExercisedProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (negativeLiveCloudRunTrafficPattern().test(value)) {
    return `Gate 16 Live traffic exercised field must confirm live Cloud Run acceptance traffic, request, or remote smoke activity before log export: ${artifact}.`;
  }

  return liveCloudRunTrafficPattern().test(value)
    ? undefined
    : `Gate 16 Live traffic exercised field must confirm live Cloud Run acceptance traffic, request, or remote smoke activity before log export: ${artifact}.`;
}

function liveCloudRunTrafficPattern(): RegExp {
  return /\b(?:live|deployed|cloud run|remote)\b.*\b(?:traffic|request|smoke|healthz|mcp|acceptance)\b|\b(?:traffic|request|smoke|healthz|mcp|acceptance)\b.*\b(?:live|deployed|cloud run|remote)\b/iu;
}

function negativeLiveCloudRunTrafficPattern(): RegExp {
  return /\b(?:no|without)\s+(?:live|deployed|cloud run|remote)\b.{0,80}\b(?:traffic|requests?|smoke|healthz|mcp|acceptance)\b|\b(?:live|deployed|cloud run|remote)\b.{0,80}\b(?:traffic|requests?|smoke|healthz|mcp|acceptance)\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:exercised|sent|run|called|performed|completed)\b|\b(?:local dry run only|dry run only|local only|not exercised|not sent|not run|not called|no deployed requests?|no live traffic)\b/isu;
}

function gate16LogExportCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Log export command field must show the gcloud logging read command with a Cloud Run resource filter: ${artifact}.`;
  }

  const hasGcloudLoggingRead = /\bgcloud\s+logging\s+read\b/iu.test(value);
  const hasCloudRunFilter =
    /\b(?:cloud_run_revision|run\.googleapis\.com|resource\.type|service_name|revision_name|run\.app)\b/iu.test(
      value,
    );

  return hasGcloudLoggingRead && hasCloudRunFilter
    ? undefined
    : `Gate 16 Log export command field must show the gcloud logging read command with a Cloud Run resource filter: ${artifact}.`;
}

function gate16VerifierCommandProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Verifier command field must show cloud-run:logs:verify with --logs-json and --require-audit-events: ${artifact}.`;
  }

  return /\bcloud-run:logs:verify\b/iu.test(value) &&
    /(?:^|\s)--logs-json(?:\s|=|$)/iu.test(value) &&
    /(?:^|\s)--require-audit-events(?:\s|$)/iu.test(value)
    ? undefined
    : `Gate 16 Verifier command field must show cloud-run:logs:verify with --logs-json and --require-audit-events: ${artifact}.`;
}

function gate16AuditEventReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (negativeAuditEventReviewPattern().test(value)) {
    return `Gate 16 Audit event review field must confirm audit events were metadata-only or limited to the allowed field set: ${artifact}.`;
  }

  return auditEventMetadataOnlyPattern().test(value)
    ? undefined
    : `Gate 16 Audit event review field must confirm audit events were metadata-only or limited to the allowed field set: ${artifact}.`;
}

function auditEventMetadataOnlyPattern(): RegExp {
  return /\baudit(?: event)?s?\b.*\b(?:metadata[- ]only|allowed (?:metadata|field|field set)|safe metadata)\b|\b(?:metadata[- ]only|allowed (?:metadata|field|field set)|safe metadata)\b.*\baudit(?: event)?s?\b/iu;
}

function negativeAuditEventReviewPattern(): RegExp {
  return /\baudit(?: event)?s?\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:metadata[- ]only|limited|safe|allowed)\b|\b(?:not|never)\b.{0,40}\b(?:metadata[- ]only|limited|safe|allowed)\b.{0,80}\baudit(?: event)?s?\b|\b(?:audit(?: event)?s?)\b.{0,120}\b(?:raw log|request body|response body|draft content|secret|cookie|bearer|token)\b|\b(?:pending|todo|not reviewed|not checked|unknown)\b/isu;
}

function gate16FindingReviewProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Finding review field must record no findings or a sanitized finding-category summary: ${artifact}.`;
  }

  const hasNoFindings = noFindingsPattern().test(value);

  if (!hasNoFindings && narrowNoFindingCategoryPattern().test(value)) {
    return `Gate 16 Finding review field must record no findings or a sanitized finding-category summary: ${artifact}.`;
  }

  const hasSanitizedSummary =
    /\b(?:sanitized|category|categories|finding summary|finding-category|redacted)\b/iu.test(
      value,
    ) &&
    /\b(?:no raw|without raw|redacted|count|counts?|summary)\b/iu.test(value);

  return hasNoFindings || hasSanitizedSummary
    ? undefined
    : `Gate 16 Finding review field must record no findings or a sanitized finding-category summary: ${artifact}.`;
}

function noFindingsPattern(): RegExp {
  return /\b(?:no|zero|0)\b\s+(?:findings?|leaks?|issues?)\b|\b(?:findings?|leaks?|issues?)\b.*\b(?:none|absent|zero|0)\b/iu;
}

function narrowNoFindingCategoryPattern(): RegExp {
  return /\b(?:no|zero|0)\b.*\b(?:secret|draft content|sensitive|token|cookie|bearer)\b.*\b(?:findings?|leaks?|issues?)\b|\b(?:secret|draft content|sensitive|token|cookie|bearer)\b.*\b(?:findings?|leaks?|issues?)\b.*\b(?:none|absent|zero|0)\b/iu;
}

function gate16RawLogHandlingProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  return rawLogSafeHandlingPattern().test(value) &&
    !contradictoryRawLogHandlingPattern().test(value)
    ? undefined
    : `Gate 16 Raw log handling field must confirm raw log entries were not pasted, copied, exposed, or recorded in evidence: ${artifact}.`;
}

function rawLogSafeHandlingPattern(): RegExp {
  return /\b(?:no|not|never|without)\b.*\braw log(?: entry| entries|s)?\b.*\b(?:included|pasted|recorded|copied|printed|exposed|attached)\b|\braw log(?: entry| entries|s)?\b.*\b(?:not|never)\b.*\b(?:included|pasted|recorded|copied|printed|exposed|attached)\b|\b(?:retained|stored|deleted|removed)\b.*\b(?:log export|exported logs?|raw logs?)\b.*\b(?:access|restricted|local|private|deleted|removed|not recorded|not included)\b/iu;
}

function contradictoryRawLogHandlingPattern(): RegExp {
  return /\b(?:but|however|except|although)\b.{0,160}\b(?:raw log(?: entry| entries|s)?\b.{0,80}\b(?:pasted|copied|recorded|printed|exposed|attached|included)\b|(?:pasted|copied|recorded|printed|exposed|attached|included)\b.{0,80}\braw log(?: entry| entries|s)?\b)/isu;
}

function gate16FollowUpActionProblem(
  artifact: string,
  gateId: number,
  value: string,
): string | undefined {
  if (gateId !== 16) {
    return undefined;
  }

  if (incompleteReviewPattern().test(value)) {
    return `Gate 16 Follow-up action field must record rotation/redeploy/deletion follow-up or no-action reasoning: ${artifact}.`;
  }

  if (unsafeNoActionAfterLogFindingPattern().test(value)) {
    return `Gate 16 Follow-up action field must record rotation/redeploy/deletion follow-up or no-action reasoning: ${artifact}.`;
  }

  const hasAction =
    /\b(?:no action|no rotation|not rotated|rotate|rotated|rotation|redeploy|re-deploy|delete|deleted|purge|retain|retained)\b/iu.test(
      value,
    );
  const hasReason =
    /\b(?:because|reason|after|follow[- ]?up|scheduled|completed|finding|findings|no findings|no leaks|secret|credential|raw logs?|exposed|not exposed)\b/iu.test(
      value,
    );

  return hasAction && hasReason
    ? undefined
    : `Gate 16 Follow-up action field must record rotation/redeploy/deletion follow-up or no-action reasoning: ${artifact}.`;
}

function unsafeNoActionAfterLogFindingPattern(): RegExp {
  return /\b(?:no action|no rotation|not rotated)\b(?=[\s\S]*\b(?:finding|findings|leak|leaks|raw logs?|secret|credential|token|cookie|bearer|exposed)\b)(?![\s\S]*\b(?:no findings|no leaks|no issues|not exposed|not leaked|no exposure|no raw logs? (?:included|recorded|pasted|copied|exposed)|metadata[- ]only|sanitized|redacted)\b)/iu;
}

function requiredGateDetailFields(gateId: number): readonly string[] {
  switch (gateId) {
    case 7:
      return [
        "Fixture directory",
        "Fixture readiness command",
        "Fixture compatibility command",
        "Fixture provenance review",
        "Draft URL or ID",
        "Title/subtitle review",
        "Text formatting review",
        "Image rendering review",
        "Native code block rendering review",
        "Native LaTeX rendering review",
        "Substack preview review",
        "Unpublished status review",
        "Cleanup decision",
      ];
    case 8:
      return [
        "Draft URL or ID",
        "Created title before update",
        "Updated title after update",
        "Update command",
        "Field update review",
        "Unpublished status after update",
        "Post-update `get_draft` review",
        "Draft body handling review",
        "Cleanup decision",
      ];
    case 9:
      return [
        "Draft URL or ID read",
        "`list_drafts` result",
        "`get_draft` result",
        "Metadata fields reviewed",
        "Body inclusion review",
        "Post-update readback review",
        "Raw body/content handling",
        "Follow-up action",
      ];
    case 11:
      return [
        "Connector URL",
        "ChatGPT surface tested",
        "Tool-list result",
        "Manual flow result",
        "Draft or review reference",
        "Tunnel exposure window",
        "Unexpected traffic review",
        "Rotation decision",
      ];
    case 12:
      return [
        "GCP project/region/service",
        "Service URL checked",
        "Deploy command source",
        "Health check result",
        "Remote smoke result",
        "Auth mode deployed",
        "Budget guard review",
        "Path-secret review",
      ];
    case 13:
      return [
        "Secret references checked",
        "Required secret names",
        "Runtime service account",
        "Secret access bindings",
        "Version policy",
        "Literal env review",
        "Secret value handling",
        "Rotation follow-up",
      ];
    case 14:
      return [
        "Client tested",
        "Endpoint tested",
        "Header configuration method",
        "Tool-list result",
        "Validation call result",
        "Rejection proof",
        "Token redaction review",
      ];
    case 15:
      return [
        "Client tested",
        "Config path or add command",
        "Server entrypoint path",
        "Tool-list result",
        "Validation call result",
        "Credential locality review",
      ];
    case 16:
      return [
        "Log export window",
        "Cloud Run service/revision",
        "Live traffic exercised",
        "Log export command",
        "Verifier command",
        "Audit event review",
        "Finding review",
        "Raw log handling",
        "Follow-up action",
      ];
    default:
      return [];
  }
}

function markdownListFieldValue(
  text: string,
  field: string,
): string | undefined {
  const match = new RegExp(
    `^[ \\t]*[-*][ \\t]+${escapeRegExp(field)}:[ \\t]*(.*)$`,
    "mu",
  ).exec(text);
  return match?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cloudRunEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (
    (gateId !== 12 && gateId !== 13) ||
    !text.includes("# V1 Cloud Run Deployment Evidence")
  ) {
    return undefined;
  }

  const missingPassingChecks = requiredCloudRunRuntimeCheckIds(
    cloudRunArtifactAuthMode(text),
  ).filter((checkId) => !text.includes(`- [x] ${checkId}`));
  if (missingPassingChecks.length > 0) {
    return `Cloud Run evidence artifact is missing passing runtime-env verifier check(s) ${missingPassingChecks.join(", ")}; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate ${gateId}: ${artifact}.`;
  }

  if (!text.includes("- Complete: yes")) {
    return `Cloud Run evidence artifact is not complete; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate ${gateId}: ${artifact}.`;
  }

  if (!cloudRunAuthModeLinePattern().test(text)) {
    return `Cloud Run evidence artifact is missing generated auth-mode proof; rerun cloud-run:verify with the deployed --auth-mode before recording gate ${gateId}: ${artifact}.`;
  }

  const missingChecklistItems = requiredCloudRunEvidenceChecklistLabels(
    gateId,
  ).filter((label) => !text.includes(`- [x] ${label}`));
  if (missingChecklistItems.length > 0) {
    return `Cloud Run evidence artifact is missing completed deployment checklist item(s) ${missingChecklistItems.join(", ")}; complete the generated Cloud Run review checklist before recording gate ${gateId}: ${artifact}.`;
  }

  return undefined;
}

function requiredCloudRunRuntimeCheckIds(
  authMode: "noauth" | "static_bearer" | "oauth" | undefined,
): readonly string[] {
  const shared = [
    "env_substack_publication_url",
    "env_substack_user_id",
    "env_max_body_bytes",
    "env_max_image_bytes",
    "env_substack_request_timeout_ms",
    "env_confirmation_token_ttl_seconds",
  ];
  if (authMode !== "oauth") {
    return shared;
  }

  return [
    ...shared,
    "env_mcp_public_base_url",
    "env_oauth_authorization_server_url",
    "env_oauth_jwks_url",
    "env_oauth_jwt_algorithms",
  ];
}

function cloudRunAuthModeLinePattern(): RegExp {
  return /^- Auth mode: (?:noauth|static_bearer|oauth)$/mu;
}

function cloudRunArtifactAuthMode(
  text: string,
): "noauth" | "static_bearer" | "oauth" | undefined {
  const match = /^- Auth mode: (noauth|static_bearer|oauth)$/mu.exec(text);
  return match?.[1] as "noauth" | "static_bearer" | "oauth" | undefined;
}

function requiredCloudRunEvidenceChecklistLabels(
  gateId: 12 | 13,
): readonly string[] {
  switch (gateId) {
    case 12:
      return [
        "Exported service JSON came from the intended GCP project, region, and Cloud Run service.",
        "`cloud-run:verify` completed with all checks passing.",
        "Cloud Run service URL was checked with `/healthz`.",
        "Remote MCP smoke passed against the deployed service URL.",
        "Evidence was reviewed to confirm no raw Secret Manager values, bearer tokens, or draft contents are included.",
      ];
    case 13:
      return [
        "Exported service JSON came from the intended GCP project, region, and Cloud Run service.",
        "`cloud-run:verify` completed with all checks passing.",
        "Secret Manager references were verified without exposing secret values.",
        "Service account secret-access bindings were confirmed for the deployed runtime service account.",
        "Evidence was reviewed to confirm no raw Secret Manager values, bearer tokens, or draft contents are included.",
      ];
  }
}

function cloudRunLogsEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId !== 16 || !text.includes("# V1 Cloud Run Log Safety Evidence")) {
    return undefined;
  }

  if (!text.includes("- Complete: yes")) {
    return `Cloud Run log evidence artifact is not complete; rerun cloud-run:logs:verify with --require-audit-events after live Cloud Run acceptance traffic before recording gate 16: ${artifact}.`;
  }

  if (!/- Audit events found: [1-9]\d*/u.test(text)) {
    return `Cloud Run log evidence artifact is missing required audit events; rerun cloud-run:logs:verify with --require-audit-events after live Cloud Run acceptance traffic before recording gate 16: ${artifact}.`;
  }

  const missingChecks = requiredCloudRunLogCheckLabels().filter(
    (checkLabel) => !text.includes(`- [x] ${checkLabel}:`),
  );
  if (missingChecks.length > 0) {
    return `Cloud Run log evidence artifact is missing passing verifier check(s) ${missingChecks.join(", ")}; rerun cloud-run:logs:verify with --require-audit-events before recording gate 16: ${artifact}.`;
  }

  const missingChecklistItems = requiredCloudRunLogChecklistLabels().filter(
    (label) => !text.includes(`- [x] ${label}`),
  );
  if (missingChecklistItems.length === 0) {
    return undefined;
  }

  return `Cloud Run log evidence artifact is missing completed log-review checklist item(s) ${missingChecklistItems.join(", ")}; complete the generated Cloud Run log review checklist before recording gate 16: ${artifact}.`;
}

function requiredCloudRunLogCheckLabels(): readonly string[] {
  return [
    "log entries present",
    "no secret patterns or fields",
    "no draft content fields",
    "audit events metadata only",
  ];
}

export function requiredCloudRunLogChecklistLabels(): readonly string[] {
  return [
    "Logs were exported after live Cloud Run acceptance traffic.",
    "`cloud-run:logs:verify` completed with required audit events.",
    "Exported logs contained no cookie, bearer-token, secret-environment, or private MCP path leaks.",
    "Exported logs contained no draft content or request/response body fields.",
    "Audit events were metadata-only and used the allowed field set.",
    "Evidence was reviewed to confirm no raw log entries or secret values are included.",
  ];
}

function staticBearerRemoteEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId !== 14 || !text.includes("# V1 Static Bearer Remote Evidence")) {
    return undefined;
  }

  const missingProofs = requiredStaticBearerRemoteProofs().filter(
    (proof) => !text.includes(proof),
  );
  if (missingProofs.length === 0) {
    return undefined;
  }

  return `Static bearer remote evidence artifact is missing current bearer-rejection proof(s) ${missingProofs.join(", ")}; rerun smoke:remote or smoke:ngrok-static-bearer before recording gate 14: ${artifact}.`;
}

function requiredStaticBearerRemoteProofs(): readonly string[] {
  return [
    "- Missing bearer status: 401",
    "- Wrong bearer status: 401",
    "- [x] Missing bearer token was rejected with HTTP 401.",
    "- [x] Wrong bearer token was rejected with HTTP 401.",
  ];
}

function chatGptNgrokEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId !== 11 || !text.includes("# V1 ChatGPT Ngrok Evidence")) {
    return undefined;
  }

  const missingProofs = requiredChatGptNgrokRemoteProofs().filter(
    (proof) => !text.includes(proof),
  );
  if (missingProofs.length === 0) {
    return undefined;
  }

  return `ChatGPT/ngrok evidence artifact is missing current remote-smoke proof(s) ${missingProofs.join(", ")}; rerun smoke:remote-noauth or smoke:ngrok-noauth before recording gate 11: ${artifact}.`;
}

function requiredChatGptNgrokRemoteProofs(): readonly string[] {
  return [
    "- Auth mode: noauth",
    "- Health status: 200",
    "- Tool count: 7",
    "- [x] Remote endpoint responded on `/healthz`.",
    "- [x] Remote noauth MCP endpoint listed exactly the seven V1 draft-workflow tools.",
    "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
    "- [x] `preview_draft` completed without calling Substack or write tools.",
  ];
}

function localStdioEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (gateId !== 15 || !text.includes("# V1 Stdio Client Evidence")) {
    return undefined;
  }

  const missingProofs = requiredLocalStdioProofs().filter(
    (proof) => !text.includes(proof),
  );
  if (missingProofs.length === 0) {
    return undefined;
  }

  return `Stdio client evidence artifact is missing current local-stdio smoke proof(s) ${missingProofs.join(", ")}; rerun smoke:stdio before recording gate 15: ${artifact}.`;
}

function requiredLocalStdioProofs(): readonly string[] {
  return [
    "- Transport: stdio",
    "- Tool count: 7",
    "- [x] Built stdio entrypoint launched and exposed exactly the seven V1 draft-workflow tools.",
    "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
    "- [x] `preview_draft` completed without calling Substack or write tools.",
  ];
}

function remoteOAuthEvidenceArtifactProblem(
  artifact: string,
  text: string,
): string | undefined {
  if (!text.includes("# V1 Remote OAuth Evidence")) {
    return undefined;
  }

  const missingProofs = requiredRemoteOAuthProofs().filter(
    (proof) => !text.includes(proof),
  );
  if (missingProofs.length > 0) {
    return `Remote OAuth evidence artifact is missing current OAuth smoke proof(s) ${missingProofs.join(", ")}; rerun smoke:remote-oauth or smoke:ngrok-oauth before treating it as launch evidence: ${artifact}.`;
  }

  const discoveryProblem = remoteOAuthDiscoveryProofProblem(artifact, text);
  if (discoveryProblem) {
    return discoveryProblem;
  }

  const missingChecklistItems =
    requiredRemoteOAuthLaunchChecklistLabels().filter(
      (label) => !text.includes(`- [x] ${label}`),
    );
  if (missingChecklistItems.length > 0) {
    return `Remote OAuth evidence artifact is missing completed launch checklist item(s) ${missingChecklistItems.join(", ")}; complete the generated OAuth launch checklist before treating it as launch evidence: ${artifact}.`;
  }

  if (!text.includes("## Manual OAuth Launch Review")) {
    return `Remote OAuth evidence artifact is missing the manual OAuth launch review section: ${artifact}.`;
  }

  const launchReview = new Map<string, string>();
  for (const field of requiredRemoteOAuthLaunchReviewFields()) {
    const value = markdownListFieldValue(text, field);
    if (value === undefined) {
      return `Remote OAuth evidence artifact is missing launch review field ${field}: ${artifact}.`;
    }
    if (value.trim().length === 0) {
      return `Remote OAuth evidence artifact has empty launch review field ${field}: ${artifact}.`;
    }
    launchReview.set(field, value);
  }

  const launchReviewProblem = remoteOAuthLaunchReviewProblem(
    artifact,
    launchReview,
  );
  if (launchReviewProblem) {
    return launchReviewProblem;
  }

  return undefined;
}

function requiredRemoteOAuthProofs(): readonly string[] {
  return [
    "- Auth mode: oauth",
    "- Health status: 200",
    "- Metadata CORS allow-origin: *",
    "- Metadata CORS preflight status: 204",
    "- Metadata CORS preflight allows authorization: yes",
    "- Metadata CORS preflight exposes WWW-Authenticate: yes",
    "- Tool count: 7",
  ];
}

function remoteOAuthDiscoveryProofProblem(
  artifact: string,
  text: string,
): string | undefined {
  const requiredProofs: readonly {
    readonly label: string;
    readonly pattern: RegExp;
  }[] = [
    {
      label: "authorization-server discovery URL",
      pattern: /^- Authorization server discovery URL: https:\/\/\S+$/mu,
    },
    {
      label: "authorization-server discovery type",
      pattern:
        /^- Authorization server discovery type: (?:oauth-authorization-server|openid-configuration)$/mu,
    },
    {
      label: "authorization-server issuer",
      pattern: /^- Authorization server issuer: https:\/\/\S+$/mu,
    },
    {
      label: "authorization endpoint",
      pattern: /^- Authorization endpoint: https:\/\/\S+$/mu,
    },
    {
      label: "token endpoint",
      pattern: /^- Token endpoint: https:\/\/\S+$/mu,
    },
    {
      label: "JWKS URI",
      pattern: /^- JWKS URI: https:\/\/\S+$/mu,
    },
    {
      label: "authorization_code grant",
      pattern: /^- Authorization grant types: .*\bauthorization_code\b.*$/mu,
    },
    {
      label: "code response type",
      pattern: /^- Authorization response types: .*\bcode\b.*$/mu,
    },
    {
      label: "PKCE S256 support",
      pattern: /^- PKCE methods: .*\bS256\b.*$/mu,
    },
  ];
  const missing = requiredProofs
    .filter((proof) => !proof.pattern.test(text))
    .map((proof) => proof.label);

  return missing.length === 0
    ? undefined
    : `Remote OAuth evidence artifact is missing authorization-server discovery proof(s) ${missing.join(", ")}; rerun smoke:remote-oauth or smoke:ngrok-oauth before treating it as launch evidence: ${artifact}.`;
}

export function requiredRemoteOAuthLaunchChecklistLabels(): readonly string[] {
  return [
    "Remote endpoint responded on `/healthz`.",
    "OAuth protected-resource metadata was served from the MCP origin.",
    "OAuth protected-resource metadata allowed browser CORS reads and preflight.",
    "Metadata advertised the required V1 OAuth scopes.",
    "Remote OAuth MCP endpoint accepted a real OAuth bearer access token.",
    "Endpoint listed exactly the seven V1 draft-workflow tools.",
    "`validate_newsletter_content` completed against the rich Markdown fixture.",
    "`preview_draft` completed without calling Substack or write tools.",
    "A real browser authorization-code login was completed against the intended authorization server.",
    "ChatGPT connector completed the OAuth login flow and listed the same seven V1 draft-workflow tools.",
    "Token expiry, audience, issuer, and scope behavior were verified without recording token values.",
    "Evidence was reviewed to confirm no OAuth token, authorization code, Substack credential, or draft content is included.",
  ];
}

function requiredRemoteOAuthLaunchReviewFields(): readonly string[] {
  return [
    "Evidence artifact",
    "Authorization server tested",
    "OAuth client tested",
    "Browser login result",
    "Connector registration result",
    "Protected-resource metadata result",
    "Token validation result",
    "Tool-list result",
    "Validation call result",
    "Preview call result",
    "Error-path result",
    "Token redaction review",
    "Launch decision",
  ];
}

function remoteOAuthLaunchReviewProblem(
  artifact: string,
  review: ReadonlyMap<string, string>,
): string | undefined {
  const authorizationServer = review.get("Authorization server tested") ?? "";
  if (
    !/\b(?:authorization server|issuer|discovery|oidc|oauth)\b/iu.test(
      authorizationServer,
    ) ||
    !/\b(?:tested|reviewed|verified|checked)\b/iu.test(authorizationServer)
  ) {
    return `Remote OAuth Authorization server tested field must identify the intended issuer or authorization server and confirm discovery review: ${artifact}.`;
  }

  const oauthClient = review.get("OAuth client tested") ?? "";
  if (
    !/\bChatGPT\b/iu.test(oauthClient) ||
    !/\b(?:connector|client|app)\b/iu.test(oauthClient)
  ) {
    return `Remote OAuth OAuth client tested field must name the ChatGPT connector or client used for the launch check: ${artifact}.`;
  }

  const browserLogin = review.get("Browser login result") ?? "";
  if (
    !/\b(?:authorization[- ]code|auth(?:orization)? code|code flow)\b/iu.test(
      browserLogin,
    ) ||
    !/\bPKCE\b/iu.test(browserLogin) ||
    !/\b(?:completed|passed|succeeded|successful|linked|authorized)\b/iu.test(
      browserLogin,
    )
  ) {
    return `Remote OAuth Browser login result field must confirm a real authorization-code + PKCE browser login completed: ${artifact}.`;
  }

  const connectorRegistration =
    review.get("Connector registration result") ?? "";
  if (
    !/\b(?:ChatGPT|connector|client)\b/iu.test(connectorRegistration) ||
    !/\b(?:registered|linked|connected|configured|completed|listed)\b/iu.test(
      connectorRegistration,
    )
  ) {
    return `Remote OAuth Connector registration result field must confirm the ChatGPT connector was registered, linked, or configured: ${artifact}.`;
  }

  const metadata = review.get("Protected-resource metadata result") ?? "";
  if (
    !/\b(?:protected[- ]resource|metadata|resource metadata)\b/iu.test(
      metadata,
    ) ||
    !/\b(?:cors|challenge|www-authenticate|resource)\b/iu.test(metadata) ||
    !/\b(?:reviewed|verified|checked|served|confirmed)\b/iu.test(metadata)
  ) {
    return `Remote OAuth Protected-resource metadata result field must confirm protected-resource metadata, CORS, and challenge review: ${artifact}.`;
  }

  const tokenValidation = review.get("Token validation result") ?? "";
  if (
    !/\bissuer\b/iu.test(tokenValidation) ||
    !/\b(?:audience|resource)\b/iu.test(tokenValidation) ||
    !/\b(?:expiry|expiration|expires|exp)\b/iu.test(tokenValidation) ||
    !/\bscope(?:s)?\b/iu.test(tokenValidation)
  ) {
    return `Remote OAuth Token validation result field must confirm issuer, audience/resource, expiry, and scope checks: ${artifact}.`;
  }

  const toolList = review.get("Tool-list result") ?? "";
  if (!exactSevenToolListReviewPattern(toolList)) {
    return `Remote OAuth Tool-list result field must confirm exactly seven V1 draft-workflow tools were listed: ${artifact}.`;
  }

  const validationCall = review.get("Validation call result") ?? "";
  if (
    !/\bvalidate_newsletter_content\b/iu.test(validationCall) ||
    !/\b(?:ok|passed|success|succeeded|completed)\b/iu.test(validationCall)
  ) {
    return `Remote OAuth Validation call result field must confirm validate_newsletter_content succeeded: ${artifact}.`;
  }

  const previewCall = review.get("Preview call result") ?? "";
  if (
    !/\bpreview_draft\b/iu.test(previewCall) ||
    !/\b(?:confirmation token|preview|ok|passed|success|succeeded|completed)\b/iu.test(
      previewCall,
    )
  ) {
    return `Remote OAuth Preview call result field must confirm preview_draft succeeded: ${artifact}.`;
  }

  const errorPath = review.get("Error-path result") ?? "";
  if (
    !/\b(?:missing|expired|wrong[- ]audience|wrong audience|invalid)\b/iu.test(
      errorPath,
    ) ||
    !/\b(?:tokens?|bearer)\b/iu.test(errorPath) ||
    !/\b(?:rejected|401|unauthorized|failed)\b/iu.test(errorPath)
  ) {
    return `Remote OAuth Error-path result field must confirm missing, expired, wrong-audience, or invalid token rejection: ${artifact}.`;
  }

  const redaction = review.get("Token redaction review") ?? "";
  if (
    !/\b(?:no|not|without|absent|none|redacted)\b/iu.test(redaction) ||
    !/\b(?:token|code|credential|secret)\b/iu.test(redaction) ||
    !/\b(?:included|recorded|pasted|printed|exposed|logged|stored)\b/iu.test(
      redaction,
    ) ||
    sensitiveValueUnsafeHandlingPattern(redaction, oauthTokenSubjectPattern())
  ) {
    return `Remote OAuth Token redaction review field must confirm no token, code, credential, or secret value was included, recorded, pasted, exposed, or logged: ${artifact}.`;
  }

  const launchDecision = review.get("Launch decision") ?? "";
  if (
    /\b(?:pending|todo|unknown|undecided|not decided|left open)\b/iu.test(
      launchDecision,
    ) ||
    !/\b(?:ChatGPT|OAuth|launch|durable|public|private)\b/iu.test(
      launchDecision,
    ) ||
    !/\b(?:ready|approved|deferred|blocked|not ready|follow[- ]?up|decision)\b/iu.test(
      launchDecision,
    )
  ) {
    return `Remote OAuth Launch decision field must record whether durable ChatGPT OAuth launch is ready or deferred with a reason/follow-up: ${artifact}.`;
  }

  return undefined;
}

function liveSubstackEvidenceArtifactProblem(
  artifact: string,
  text: string,
  gateId: number | undefined,
): string | undefined {
  if (
    (gateId !== 7 && gateId !== 8 && gateId !== 9) ||
    !text.includes("# V1 Live Substack Draft Flow Evidence")
  ) {
    return undefined;
  }

  const missingProofs = requiredLiveSubstackProofs(gateId).filter(
    (proof) => !text.includes(proof),
  );
  if (missingProofs.length === 0) {
    return undefined;
  }

  return `Live Substack evidence artifact is missing current automated proof(s) ${missingProofs.join(", ")}; rerun test:live with V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS before recording gate ${gateId}: ${artifact}.`;
}

function requiredLiveSubstackProofs(gateId: 7 | 8 | 9): readonly string[] {
  switch (gateId) {
    case 7:
      return [
        "- [x] `upload_image` returned a hosted image URL.",
        "- [x] `create_draft` created a draft.",
      ];
    case 8:
      return [
        "- [x] `update_draft` updated the same draft.",
        "- [x] `get_draft` fetched the updated draft metadata.",
      ];
    case 9:
      return [
        "- [x] `list_drafts` found the created draft.",
        "- [x] `get_draft` fetched the created draft metadata.",
        "- [x] `get_draft` fetched the updated draft metadata.",
      ];
  }
}
