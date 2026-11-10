import React from 'react';
import type { Project } from '@shared/contracts/domain/models';
import { MoreHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnGhost, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { normalizeProjectModalities } from '@shared/domain/projectModalities';
import { formatModalitySummary } from '@/modalities/registry';
import { useLanguage } from '@/app/i18n/useLanguage';

interface DashboardPageProps {
  projects: Project[];
  projectDirs?: Record<string, string>;
  onOpenProject: (projectId: string) => void;
  onShowInFinder: (projectId: string) => void;
  onRemoveFromList: (projectId: string) => void;
  onSetProjectDisplayName: (projectId: string, displayName: string) => void;
}

const DEVICE_MODEL_LABELS: Record<string, string> = {
  Pro: 'Pro',
  A8: 'A8',
  aSeeGlassesPlus: 'aSee Glasses Plus',
  PupilCore: 'Pupil Core',
};

const DashboardPage: React.FC<DashboardPageProps> = ({
  projects,
  projectDirs = {},
  onOpenProject,
  onShowInFinder,
  onRemoveFromList,
  onSetProjectDisplayName,
}) => {
  const { language } = useLanguage();
  const [menuOpenFor, setMenuOpenFor] = React.useState<string | null>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number } | null>(null);
  const [renameProjectId, setRenameProjectId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState<string>('');

  React.useEffect(() => {
    if (!menuOpenFor) return;
    const onDoc = () => setMenuOpenFor(null);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpenFor]);

  React.useEffect(() => {
    if (!menuOpenFor) return;
    const onResize = () => setMenuOpenFor(null);
    const onScroll = () => setMenuOpenFor(null);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuOpenFor]);

  const openRename = (projectId: string) => {
    setRenameProjectId(projectId);
    const p = projects.find((it) => it.id === projectId);
    setRenameValue(String(p?.name || ''));
  };

  const formatUpdatedAt = (s: string): string => {
    const raw = String(s || '').trim();
    if (!raw) return '—';
    if (/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return raw;
    const d = new Date(t);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };

  const formatDeviceModel = (project: Project): string => {
    return formatModalitySummary(normalizeProjectModalities(project).map((item) => item.id), language);
  };

  const formatDeviceModelLabel = (project: Project): string => {
    if (!project.deviceModel) return '-';
    return DEVICE_MODEL_LABELS[project.deviceModel] ?? project.deviceModel;
  };

  return (
    <div className="mrt-float-list-panel h-full min-h-0 overflow-auto bg-white rounded-2xl shadow-sm border border-slate-200">
      {projects.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-sm">暂无工程，请先选择“项目存储路径”,开始创建“新建工程”</div>
      ) : (
        <table className="mrt-float-list w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-sm font-semibold text-slate-600">工程名称</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-600">工程模态</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-600">眼动设备类型</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-600">负责人</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-600">上次操作时间</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-600 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {projects.map((p) => {
              const dir = projectDirs[p.id] || '';
              return (
              <tr key={p.id} className="transition-colors">
                <td className="px-0 py-0">
                  <button
                    onClick={() => onOpenProject(p.id)}
                    className={`${btnGhost} mrt-button-row !block w-full h-full !px-6 !py-4 !whitespace-normal text-left group`}
                    type="button"
                  >
                    <div
                      data-i18n-skip="true"
                      className="text-sm text-slate-700 font-semibold group-hover:text-sky-600 transition-colors"
                    >
                      {p.name}
                    </div>
                    <div
                      data-i18n-skip="true"
                      className="mt-1 text-[11px] text-slate-400 font-mono truncate max-w-[520px]"
                      title={dir || ''}
                    >
                      {dir || '—'}
                    </div>
                  </button>
                </td>
                <td className="px-6 py-4 text-sm text-slate-500 font-medium">
                  {formatDeviceModel(p)}
                </td>
                <td data-i18n-skip="true" className="px-6 py-4 text-sm text-slate-500 font-medium">{formatDeviceModelLabel(p)}</td>
                <td data-i18n-skip="true" className="px-6 py-4 text-sm text-slate-500">{p.manager}</td>
                <td data-i18n-skip="true" className="mrt-number px-6 py-4 text-sm text-slate-500">{formatUpdatedAt(p.updatedAt || '')}</td>
                <td className="px-6 py-4 text-right">
                  <div className="relative inline-flex">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                        const menuWidth = 160;
                        const top = rect.bottom + 4;
                        const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
                        setMenuPos({ top, left });
                        setMenuOpenFor((cur) => (cur === p.id ? null : p.id));
                      }}
                      className={`${btnGhost} h-8 w-8 !p-0`}
                      aria-label="操作"
                      aria-haspopup="menu"
                      aria-expanded={menuOpenFor === p.id}
                      type="button"
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    {menuOpenFor === p.id && (
                      createPortal(
                        <div className="fixed inset-0 z-[9999]" onClick={() => setMenuOpenFor(null)}>
                          <div
                            className="mrt-action-menu fixed w-40 bg-white border border-slate-200 shadow-lg overflow-hidden"
                            style={{ top: menuPos?.top ?? 0, left: menuPos?.left ?? 0 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className={`${btnGhost} w-full !justify-start !rounded-none !whitespace-normal text-left`}
                              type="button"
                              onClick={() => {
                                setMenuOpenFor(null);
                                onShowInFinder(p.id);
                              }}
                            >
                              在资源文件夹中显示
                            </button>
                            <button
                              className={`${btnGhost} w-full !justify-start !rounded-none !whitespace-normal text-left`}
                              type="button"
                              onClick={() => {
                                setMenuOpenFor(null);
                                openRename(p.id);
                              }}
                            >
                              设置项目显示名称
                            </button>
                            <button
                              className={`${btnDanger} w-full !justify-start !rounded-none !whitespace-normal text-left`}
                              type="button"
                              onClick={() => {
                                setMenuOpenFor(null);
                                onRemoveFromList(p.id);
                              }}
                            >
                              从列表中移除
                            </button>
                          </div>
                        </div>,
                        document.body,
                      )
                    )}
                  </div>
                </td>
              </tr>
            );
            })}
          </tbody>
        </table>
      )}

      <Modal
        isOpen={renameProjectId !== null}
        onClose={() => setRenameProjectId(null)}
        title="设置项目显示名称"
        maxWidthClassName="max-w-md"
        footer={
          <>
            <button
              onClick={() => setRenameProjectId(null)}
              className={btnSecondary}
              type="button"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (!renameProjectId) return;
                onSetProjectDisplayName(renameProjectId, renameValue);
                setRenameProjectId(null);
              }}
              className={btnPrimary}
              type="button"
            >
              保存
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-xs text-slate-500">将写入 project.json，并同步刷新工程列表</div>
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="留空表示恢复为文件夹名"
            className="w-full px-3 py-2 bg-white border border-slate-200 rounded text-sm outline-none focus:border-sky-500"
          />
        </div>
      </Modal>
    </div>
  );
};

export default DashboardPage;
