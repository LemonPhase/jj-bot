import { useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { Modal } from "../common/Modal";

export function NewBotModal({ onClose }: { onClose: () => void }) {
  const { createBot } = useWorkspace();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");

  return (
    <Modal
      title="New Bot"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={() => {
        if (!name.trim()) return;
        void createBot({
          name: name.trim(),
          role: role.trim(),
          instructions: instructions.trim(),
        });
        onClose();
      }}
    >
      <div className="form-group">
        <label className="field-label" htmlFor="new-bot-name">
          Name
        </label>
        <input
          id="new-bot-name"
          className="form-input"
          placeholder="e.g. Nova"
          required
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="field-label" htmlFor="new-bot-role">
          Role
        </label>
        <input
          id="new-bot-role"
          className="form-input"
          placeholder="e.g. Security Reviewer"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="field-label" htmlFor="new-bot-instructions">
          Instructions
        </label>
        <textarea
          id="new-bot-instructions"
          className="field-textarea"
          placeholder="System persona and boundaries..."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </div>
    </Modal>
  );
}
