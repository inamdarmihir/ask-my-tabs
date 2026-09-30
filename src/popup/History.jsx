import React from "react";
import { CloseIcon, PlusIcon, TrashIcon } from "./icons.jsx";
import { timeAgo } from "./hooks.js";

export function History({ threads, activeId, onOpen, onNew, onDelete, onClose }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Chat history">
        <div className="drawer-head">
          <h2>History</h2>
          <button className="icon-btn small" onClick={onClose} aria-label="Close history"><CloseIcon /></button>
        </div>
        <button className="btn btn-primary new-chat" onClick={onNew}><PlusIcon /> New chat</button>
        {threads.length === 0 ? (
          <p className="empty">No conversations yet. They're saved here automatically.</p>
        ) : (
          <ul className="thread-list">
            {threads.map((t) => {
              const answers = t.messages.filter((m) => m.role === "user").length;
              const pending = t.messages.some((m) => m.status === "pending");
              return (
                <li key={t.id} className={`thread ${t.id === activeId ? "active" : ""}`}>
                  <button className="thread-main" onClick={() => onOpen(t.id)}>
                    <span className="thread-title">{t.title}</span>
                    <span className="thread-sub">
                      {pending ? <span className="live">answering...</span> : `${answers} question${answers === 1 ? "" : "s"}`} · {timeAgo(t.updatedAt)}
                    </span>
                  </button>
                  <button className="icon-btn small" onClick={() => onDelete(t.id)} aria-label={`Delete conversation ${t.title}`} title="Delete conversation"><TrashIcon /></button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}
