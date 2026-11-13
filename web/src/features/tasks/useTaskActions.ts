import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID } from '@/api/types';
import { useToast } from '@/ui';
import { createTask, deleteTask, handoffAction, tasksKeys, updateTask, type HandoffAction, type TaskInput } from './tasksApi';

/** Mutations of the tasks tab (also used by «Τα δικά μου» for the quick actions). They refresh the tab and «Τα δικά μου». */
export function useTaskActions(tenderId?: ID) {
  const { t } = useTranslation('tasks');
  const toast = useToast();
  const queryClient = useQueryClient();
  const refresh = (id: ID) =>
    Promise.all([queryClient.invalidateQueries({ queryKey: tasksKeys.list(id) }), queryClient.invalidateQueries({ queryKey: ['my'] })]);
  const onError = (err: unknown) => toast.error(errorMessage(err));
  const tid = (v: { tenderId?: ID }) => v.tenderId ?? tenderId ?? '';

  const create = useMutation({
    mutationFn: (v: { tenderId?: ID; body: TaskInput }) => createTask(tid(v), v.body),
    onSuccess: (_d, v) => refresh(tid(v)),
  });
  const update = useMutation({
    mutationFn: (v: { tenderId?: ID; id: ID; body: TaskInput; silent?: boolean }) => updateTask(tid(v), v.id, v.body),
    onSuccess: async (_d, v) => {
      await refresh(tid(v));
      if (!v.silent) toast.success(t('common:state.saved'));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (v: { tenderId?: ID; id: ID }) => deleteTask(tid(v), v.id),
    onSuccess: async (_d, v) => {
      await refresh(tid(v));
      toast.success(t('common:state.deleted'));
    },
    onError,
  });
  const handoff = useMutation({
    mutationFn: (v: { tenderId?: ID; id: ID; action: HandoffAction; note?: string }) => handoffAction(tid(v), v.id, v.action, v.note),
    onSuccess: async (_d, v) => {
      await refresh(tid(v));
      toast.success(t(`handoffs.toast.${v.action}`));
    },
    onError,
  });
  return { create, update, remove, handoff };
}
