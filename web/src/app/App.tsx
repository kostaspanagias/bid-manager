import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider } from '@/ui';
import { ErrorBoundary } from './ErrorBoundary';
import { createQueryClient } from './queryClient';
import { router } from './router';

/** Providers, outermost first: error boundary → react-query → toasts → router (AuthProvider lives in the root route). */
export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
