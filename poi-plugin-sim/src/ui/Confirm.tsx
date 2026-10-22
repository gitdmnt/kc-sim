import React from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { S } from "./strings";

export const ConfirmDialog = ({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => (
  <Modal
    title={title}
    onClose={onCancel}
    className="max-w-md"
    footer={
      <>
        <Button variant="ghost" onClick={onCancel}>
          {S.common.cancel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel ?? "OK"}
        </Button>
      </>
    }
  >
    <p className="text-sm text-ink-200">{message ?? S.settings.confirm}</p>
  </Modal>
);
