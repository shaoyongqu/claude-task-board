import { useEffect, useState, type FormEvent } from "react";

import {
  createModelProfile,
  deleteModelProfile,
  setDefaultModelProfile,
  updateModelProfile,
  type ModelProfileInput,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { ModelProfile } from "../types";
import { LinearIcon } from "./LinearIcon";

interface ModelProfilesDialogProps {
  profiles: ModelProfile[];
  defaultProfileId: string | null;
  onClose: () => void;
  onChanged: () => void;
}

interface ProfileForm {
  name: string;
  provider: string;
  baseUrl: string;
  authToken: string;
  model: string;
  smallFastModel: string;
  description: string;
}

const EMPTY_FORM: ProfileForm = {
  name: "",
  provider: "",
  baseUrl: "",
  authToken: "",
  model: "",
  smallFastModel: "",
  description: "",
};

function formFromProfile(profile: ModelProfile): ProfileForm {
  return {
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? "",
    authToken: profile.authToken ?? "",
    model: profile.model,
    smallFastModel: profile.smallFastModel ?? "",
    description: profile.description ?? "",
  };
}

function inputFromForm(form: ProfileForm): ModelProfileInput {
  return {
    name: form.name.trim(),
    provider: form.provider.trim(),
    baseUrl: form.baseUrl.trim(),
    authToken: form.authToken.trim(),
    model: form.model.trim(),
    smallFastModel: form.smallFastModel.trim(),
    description: form.description.trim(),
  };
}

export function ModelProfilesDialog({
  profiles,
  defaultProfileId,
  onClose,
  onChanged,
}: ModelProfilesDialogProps) {
  const { text } = useTaskboardI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!formOpen) return;
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        if (formOpen) {
          setFormOpen(false);
          setEditingId(null);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => document.removeEventListener("keydown", closeFromEscape);
  }, [formOpen, onClose, saving]);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setError(null);
  }

  function startEdit(profile: ModelProfile) {
    setEditingId(profile.id);
    setForm(formFromProfile(profile));
    setFormOpen(true);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = inputFromForm(form);
    if (!input.name) {
      setError(text("请为模型配置填写一个名称。", "Enter a name for the model profile."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) await updateModelProfile(editingId, input);
      else await createModelProfile(input);
      setFormOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove(profile: ModelProfile) {
    if (!window.confirm(text(
      `删除模型配置“${profile.name}”？使用它的议题与会话将回退到全局默认配置。`,
      `Delete model profile "${profile.name}"? Issues and conversations using it fall back to the global default.`,
    ))) return;
    setSaving(true);
    setError(null);
    try {
      await deleteModelProfile(profile.id);
      if (editingId === profile.id) {
        setEditingId(null);
        setFormOpen(false);
      }
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(profile: ModelProfile | null) {
    setSaving(true);
    setError(null);
    try {
      await setDefaultModelProfile(profile ? profile.id : null);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="delete-dialog model-profiles-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-profiles-title"
      >
        <header className="model-profiles-header">
          <div>
            <h2 id="model-profiles-title">{text("模型管理", "Model profiles")}</h2>
            <p>{text(
              "统一管理厂商接入配置，仅保存在本机。未单独指定的会话使用全局默认配置。",
              "Manage provider profiles, stored on this device only. Sessions without an explicit profile use the global default.",
            )}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label={text("关闭", "Close")}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <div className="model-profiles-list">
          {profiles.length === 0 && (
            <p className="model-profiles-empty">
              {text("还没有模型配置，点击下方按钮新建。", "No profiles yet. Create one below.")}
            </p>
          )}
          {profiles.map((profile) => (
            <article key={profile.id} className="model-profiles-item">
              <div className="model-profiles-item-body">
                <div className="model-profiles-item-title">
                  <strong>{profile.name}</strong>
                  {defaultProfileId === profile.id && (
                    <span className="model-profiles-default-badge">
                      {text("全局默认", "Default")}
                    </span>
                  )}
                </div>
                <p
                  className="model-profiles-item-meta"
                  title={[profile.provider, profile.model].filter(Boolean).join(" · ")}
                >
                  {[profile.provider, profile.model].filter(Boolean).join(" · ")
                    || text("未指定模型", "No model")}
                </p>
                {profile.baseUrl && (
                  <p className="model-profiles-item-url" title={profile.baseUrl}>{profile.baseUrl}</p>
                )}
                {profile.description && (
                  <p className="model-profiles-item-description" title={profile.description}>
                    {profile.description}
                  </p>
                )}
              </div>
              <div className="model-profiles-item-actions">
                {defaultProfileId === profile.id ? (
                  <button type="button" disabled={saving} onClick={() => void makeDefault(null)}>
                    {text("取消默认", "Unset default")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="model-profiles-set-default"
                    disabled={saving}
                    onClick={() => void makeDefault(profile)}
                  >
                    {text("设为默认", "Set default")}
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => startEdit(profile)}>
                  {text("编辑", "Edit")}
                </button>
                <button
                  type="button"
                  className="model-profiles-delete"
                  disabled={saving}
                  onClick={() => void remove(profile)}
                >
                  {text("删除", "Delete")}
                </button>
              </div>
            </article>
          ))}
        </div>

        {formOpen ? (
          <form className="model-profiles-form" onSubmit={(event) => void submit(event)}>
            <h3>{editingId ? text("编辑配置", "Edit profile") : text("新建配置", "New profile")}</h3>
            <div className="model-profiles-form-row">
              <label>
                <span>{text("名称 *", "Name *")}</span>
                <input
                  autoFocus
                  required
                  maxLength={120}
                  placeholder={text("如：Kimi", "e.g. Kimi")}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label>
                <span>{text("厂商", "Provider")}</span>
                <input
                  maxLength={80}
                  placeholder={text("如：Moonshot", "e.g. Moonshot")}
                  value={form.provider}
                  onChange={(event) => setForm({ ...form, provider: event.target.value })}
                />
              </label>
            </div>
            <div className="model-profiles-form-row">
              <label>
                <span>{text("主模型", "Model")}</span>
                <input
                  maxLength={256}
                  placeholder={text("如：kimi-k2-0905-preview", "e.g. kimi-k2-0905-preview")}
                  value={form.model}
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                />
              </label>
              <label>
                <span>{text("轻量模型", "Small fast model")}</span>
                <input
                  maxLength={256}
                  placeholder={text("可选，留空跟随主模型", "optional")}
                  value={form.smallFastModel}
                  onChange={(event) => setForm({ ...form, smallFastModel: event.target.value })}
                />
              </label>
            </div>
            <label>
              <span>{text("接入地址（ANTHROPIC_BASE_URL）", "Base URL (ANTHROPIC_BASE_URL)")}</span>
              <input
                inputMode="url"
                maxLength={2048}
                placeholder="https://api.moonshot.cn/anthropic"
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </label>
            <label>
              <span>{text("密钥（ANTHROPIC_AUTH_TOKEN）", "Auth token (ANTHROPIC_AUTH_TOKEN)")}</span>
              <input
                type="password"
                autoComplete="off"
                maxLength={4096}
                placeholder={editingId ? text("留空则保持不变", "Leave blank to keep unchanged") : ""}
                value={form.authToken}
                onChange={(event) => setForm({ ...form, authToken: event.target.value })}
              />
            </label>
            <label>
              <span>{text("描述", "Description")}</span>
              <input
                maxLength={2000}
                placeholder={text("可选，显示在配置列表中", "optional, shown in the list")}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            {error && <p className="model-profiles-error" role="alert">{error}</p>}
            <div className="model-profiles-form-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setFormOpen(false);
                  setEditingId(null);
                }}
              >
                {text("取消", "Cancel")}
              </button>
              <button type="submit" disabled={saving} className="model-profiles-save">
                {saving ? text("保存中…", "Saving…") : text("保存", "Save")}
              </button>
            </div>
          </form>
        ) : (
          <footer className="model-profiles-footer">
            {error && <p className="model-profiles-error" role="alert">{error}</p>}
            <button type="button" className="model-profiles-add" disabled={saving} onClick={startCreate}>
              <span className="model-profiles-add-icon" aria-hidden="true">+</span>
              {text("新模型配置", "New profile")}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
