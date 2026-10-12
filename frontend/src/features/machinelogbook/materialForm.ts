import type { CreateMaterialRequest, Material, MaterialUnit } from '../../api/generated/models';

export type MaterialFields = { name: string; category: string; color: string; unit: MaterialUnit; lowStockThreshold: string; filamentDiameterMm: string };
export const emptyMaterial: MaterialFields = { name: '', category: '', color: '', unit: 'g', lowStockThreshold: '', filamentDiameterMm: '' };
export function materialFields(material: Material): MaterialFields {
  return { name: material.name, category: material.category, color: material.color ?? '', unit: material.unit, lowStockThreshold: material.lowStockThreshold ?? '', filamentDiameterMm: material.filamentDiameterMm ?? '' };
}
export function materialInput(values: MaterialFields): CreateMaterialRequest {
  return { name: values.name.trim(), category: values.category.trim().toLowerCase(), color: values.color || null, unit: values.unit, lowStockThreshold: values.lowStockThreshold || null, filamentDiameterMm: values.filamentDiameterMm || null };
}
