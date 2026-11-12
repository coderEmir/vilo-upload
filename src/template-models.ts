export type ModelOption = {
  value: string;
  label: string;
  isDefault: boolean;
  thumbnail?: string | null;
};

export type ModelParam = {
  key: string;
  label: string;
  description?: string | null;
  type: string;
  required: boolean;
  defaultValue?: string | null;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  options: ModelOption[];
};

export type Model = {
  id: string;
  code: string;
  name: string;
  modality: string;
  params: ModelParam[];
};

export type TemplateType = 'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION';

function normalizedReference(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function modelMatchesTemplateType(model: Model, type: TemplateType): boolean {
  if (type === 'IMAGE_GENERATION') return model.modality === 'IMAGE';
  if (type === 'SHORT_VIDEO') return model.modality === 'VIDEO';
  return true;
}

/** Resolve an uploaded model name/code to the backend-owned stable model code. */
export function resolveTemplateModel(
  models: Model[],
  reference: string,
  type: TemplateType,
): Model | undefined {
  const eligibleModels = models.filter((model) => modelMatchesTemplateType(model, type));
  const exactCode = eligibleModels.find((model) => model.code === reference.trim());
  if (exactCode) return exactCode;

  const normalized = normalizedReference(reference);
  const matches = eligibleModels.filter((model) =>
    normalizedReference(model.code) === normalized || normalizedReference(model.name) === normalized,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
