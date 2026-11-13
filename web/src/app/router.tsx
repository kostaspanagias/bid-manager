/**
 * All routes of the MVP, wired to pages in feature folders. Feature engineers fill the page files —
 * this file does not need to change.
 */
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AuditPage } from '@/features/admin/AuditPage';
import { HolidaysPage } from '@/features/admin/HolidaysPage';
import { UsersPage } from '@/features/admin/UsersPage';
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { LoginPage } from '@/features/auth/LoginPage';
import { ChangesTab } from '@/features/changes/ChangesTab';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { CompanyDocumentsPage } from '@/features/documents/CompanyDocumentsPage';
import { TenderDocumentsTab } from '@/features/documents/TenderDocumentsTab';
import { FilesTab } from '@/features/files/FilesTab';
import { GatesTab } from '@/features/gates/GatesTab';
import { LessonsTab } from '@/features/lessons/LessonsTab';
import { MyWorkPage } from '@/features/my/MyWorkPage';
import { RegisterTab } from '@/features/requirements/RegisterTab';
import { RisksTab } from '@/features/risks/RisksTab';
import { ScheduleTab } from '@/features/schedule/ScheduleTab';
import { TasksTab } from '@/features/tasks/TasksTab';
import { TemplateEditPage } from '@/features/templates/TemplateEditPage';
import { TemplateListPage } from '@/features/templates/TemplateListPage';
import { TeamTab } from '@/features/tenders/TeamTab';
import { TenderCreatePage } from '@/features/tenders/TenderCreatePage';
import { TenderLayout } from '@/features/tenders/TenderLayout';
import { TenderListPage } from '@/features/tenders/TenderListPage';
import { TenderOverviewTab } from '@/features/tenders/TenderOverviewTab';
import { WatchTab } from '@/features/watch/WatchTab';
import { AppLayout } from './AppLayout';
import { RouteError } from './ErrorBoundary';
import { RequireAuth, RequireRole } from './guards';
import { NotFoundPage } from './NotFoundPage';

/** Root: session context for every route (login pages included). */
function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/invite/:token', element: <AcceptInvitePage /> },
      { path: '/accept-invite', element: <AcceptInvitePage /> }, // ?token=… — the link format in the server's e-mail
      {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { path: '/', element: <DashboardPage /> },
          { path: '/tenders', element: <TenderListPage /> },
          { path: '/tenders/new', element: <TenderCreatePage /> },
          {
            path: '/tenders/:tenderId',
            element: <TenderLayout />,
            children: [
              { index: true, element: <Navigate to="overview" replace /> },
              { path: 'overview', element: <TenderOverviewTab /> },
              { path: 'schedule', element: <ScheduleTab /> },
              { path: 'gates', element: <GatesTab /> },
              { path: 'register', element: <RegisterTab /> },
              { path: 'tasks', element: <TasksTab /> },
              { path: 'watch', element: <WatchTab /> },
              { path: 'risks', element: <RisksTab /> },
              { path: 'changes', element: <ChangesTab /> },
              { path: 'files', element: <FilesTab /> },
              { path: 'documents', element: <TenderDocumentsTab /> },
              { path: 'lessons', element: <LessonsTab /> },
              { path: 'team', element: <TeamTab /> },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
          { path: '/my', element: <MyWorkPage /> },
          { path: '/company-documents', element: <CompanyDocumentsPage /> },
          {
            path: '/admin',
            element: <RequireRole roles={['admin']} />,
            children: [
              { index: true, element: <Navigate to="users" replace /> },
              { path: 'users', element: <UsersPage /> },
              { path: 'holidays', element: <HolidaysPage /> },
              { path: 'audit', element: <AuditPage /> },
              { path: 'templates', element: <TemplateListPage /> },
              { path: 'templates/:templateId', element: <TemplateEditPage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
