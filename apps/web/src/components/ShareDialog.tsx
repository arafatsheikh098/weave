import { Check, Copy, Link2, Share2, UserMinus } from "lucide-react";
import { useState } from "react";
import type { Role } from "@weave/protocol";
import { api, type Member } from "../lib/api";
import { useToast } from "./Toaster";
import { Avatar, Button, Modal, Spinner } from "./ui";

export function ShareDialog({
  open,
  onClose,
  projectId,
  members,
  myRole,
  meId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  members: Member[];
  myRole: Role;
  meId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { token } = await api.invite(projectId, role);
      const url = `${location.origin}/invite/${token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).then(
        () => {
          setCopied(true);
          toast.show({ kind: "success", title: "Invite link copied", body: `Anyone with it can join as ${role === "editor" ? "an editor" : "a viewer"}.` });
          setTimeout(() => setCopied(false), 1800);
        },
        () => {},
      );
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't create a link", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Share this project" description="Invite people to write with you in real time." icon={Share2}>
      {myRole !== "viewer" ? (
        <div className="rounded-2xl border border-line bg-surface-2 p-4">
          <div className="text-sm font-medium text-ink">Invite with a link</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl bg-surface p-1" role="radiogroup" aria-label="Role for people who join">
              {(["editor", "viewer"] as const).map((r) => (
                <button
                  key={r}
                  role="radio"
                  aria-checked={role === r}
                  onClick={() => {
                    setRole(r);
                    setLink(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${role === r ? "bg-gradient text-white shadow-sm" : "text-ink-2 hover:text-ink"}`}
                >
                  {r === "editor" ? "Can edit" : "Can view"}
                </button>
              ))}
            </div>
            <Button onClick={create} disabled={busy}>
              {busy ? <Spinner size={14} className="border-white/40 border-t-white" /> : copied ? <Check size={16} /> : <Link2 size={16} />}
              {copied ? "Copied" : "Create & copy link"}
            </Button>
          </div>
          {link && (
            <div className="fade-in mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs text-ink-2">{link}</code>
              <button
                className="rounded-md p-1 text-muted hover:text-ink"
                aria-label="Copy link"
                onClick={() => navigator.clipboard?.writeText(link).then(() => toast.show({ kind: "success", title: "Copied" }))}
              >
                <Copy size={14} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-2">You have view-only access. Ask an editor for an invite link to share.</p>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold text-ink">People with access</h3>
      <ul className="divide-y divide-[var(--border)]">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <Avatar name={m.displayName} color={m.color} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {m.displayName} {m.id === meId && <span className="text-muted">(you)</span>}
              </div>
              <div className="text-xs text-muted">@{m.username}</div>
            </div>
            {myRole === "owner" && m.role !== "owner" ? (
              <>
                <select
                  value={m.role}
                  aria-label={`Role for ${m.displayName}`}
                  onChange={async (e) => {
                    await api.setRole(projectId, m.id, e.target.value as "editor" | "viewer");
                    toast.show({ kind: "success", title: `${m.displayName} can now ${e.target.value === "editor" ? "edit" : "only view"}` });
                    onChanged();
                  }}
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                >
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view</option>
                </select>
                <button
                  className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-bad"
                  aria-label={`Remove ${m.displayName}`}
                  onClick={async () => {
                    await api.removeMember(projectId, m.id);
                    toast.show({ kind: "info", title: `${m.displayName} was removed` });
                    onChanged();
                  }}
                >
                  <UserMinus size={15} />
                </button>
              </>
            ) : (
              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium capitalize text-ink-2">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
