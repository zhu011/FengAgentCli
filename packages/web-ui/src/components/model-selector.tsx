/**
 * @fengagent/web-ui — 模型选择下拉框
 */

import { ChevronDown } from "lucide-react";
import type { ModelInfo } from "../api/types.ts";

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModel: string | null;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({
  models,
  selectedModel,
  onSelect,
  disabled,
}: ModelSelectorProps) {
  return (
    <div className="model-selector">
      <select
        className="model-selector__select"
        value={selectedModel ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled || models.length === 0}
        aria-label="Select model"
      >
        {models.length === 0 ? (
          <option value="">No models available</option>
        ) : (
          models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
              {model.isDefault ? " (default)" : ""}
            </option>
          ))
        )}
      </select>
      <ChevronDown size={16} className="model-selector__icon" />
    </div>
  );
}
