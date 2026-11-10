import React, { useState } from 'react';
import { Tag } from 'lucide-react';
import type { Subject } from '@shared/contracts/domain/models';
import type { SubjectFieldDef, CustomMarker } from '@/shared/types/mrt';
import CustomMarkersModal from '@/features/recording/CustomMarkersModal';
import { useLanguage } from '@/app/i18n/useLanguage';
import { btnDanger, btnSecondary } from '@/shared/ui/buttonClasses';
import { tableCellClass, tableHeadClass, tableRowClass } from '@/shared/ui/tableClasses';

interface SubjectPageProps {
  subjectFields: SubjectFieldDef[];
  subjects: Subject[];
  onEditSubject: (subject: Subject) => void;
  onDeleteSubject: (subject: Subject) => void;
  customMarkers: CustomMarker[];
  onSaveCustomMarkers: (markers: CustomMarker[]) => void;
}

const SubjectPage: React.FC<SubjectPageProps> = ({ 
  subjectFields, 
  subjects, 
  onEditSubject, 
  onDeleteSubject,
  customMarkers,
  onSaveCustomMarkers,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [isMarkersModalOpen, setIsMarkersModalOpen] = useState(false);
  const activeMarkers = customMarkers.filter((m) => m.active);

  return (
    <>
      <div className="mrt-float-list-panel bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-full min-w-0 flex flex-col">
        {/* 顶部工具栏 */}
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">
            受试者列表
            <span className="ml-2 text-xs font-normal text-slate-400" data-i18n-skip={isEn ? 'true' : undefined}>
              {isEn ? `${subjects.length} subjects` : `${subjects.length} 人`}
            </span>
          </h2>
          <button
            onClick={() => setIsMarkersModalOpen(true)}
            className={btnSecondary}
          >
            <Tag size={14} />
            自定义标记
          </button>
        </div>

        <div className="min-h-0 overflow-auto flex-1">
          <table className="mrt-float-list w-full min-w-[600px] text-left border-collapse">
            <thead>
              <tr>
                {subjectFields.map((field, index) => (
                  <th
                    key={field.id}
                    className={`${tableHeadClass}${field.id === 'builtin_age' ? ' text-right' : ''}${index === 0 ? ' left-0 z-30' : ''}`}
                    title={field.label}
                    data-i18n-skip={field.builtin ? undefined : 'true'}
                  >
                    <span className={field.id === 'builtin_age' ? 'block' : 'block max-w-52 truncate'}>{field.label}</span>
                  </th>
                ))}
                {activeMarkers.length > 0 && (
                  <th className={tableHeadClass}>自定义标记</th>
                )}
                <th className={`${tableHeadClass} right-0 z-30 text-right`}>操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subjects.length === 0 && (
                <tr>
                  <td
                    colSpan={subjectFields.length + (activeMarkers.length > 0 ? 1 : 0) + 1}
                    className="px-4 py-10 text-center"
                    data-i18n-skip={isEn ? 'true' : undefined}
                  >
                    <p className="text-sm font-medium text-slate-600">{isEn ? 'No subjects yet' : '暂无受试者'}</p>
                    <p className="mt-1 text-xs text-slate-500">{isEn ? 'Click “New subject” above to add your first subject.' : '点击上方“新建受试者”，添加第一位受试者。'}</p>
                  </td>
                </tr>
              )}
              {subjects.map((s) => (
                <tr key={s.id} className={tableRowClass}>
                  {subjectFields.map((field, index) => {
                    const value = String(s[field.label] ?? '').trim();
                    const isAge = field.id === 'builtin_age';
                    return (
                      <td
                        key={field.id}
                        className={`${tableCellClass}${isAge ? ' text-right mrt-number' : ''}${index === 0 ? ' sticky left-0 z-10 bg-white' : ''}`}
                        data-i18n-skip={field.builtin && field.label === '性别' ? undefined : 'true'}
                      >
                        {value
                          ? <div className={isAge ? 'whitespace-nowrap' : 'max-w-72 truncate'} title={value}>{value}</div>
                          : <span className="text-slate-400">—</span>}
                      </td>
                    );
                  })}
                  {activeMarkers.length > 0 && (
                    <td className={tableCellClass}>
                      <div className="flex min-w-40 max-w-96 flex-wrap gap-1.5">
                        {activeMarkers.map(marker => (
                          <div
                            key={marker.id}
                            className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
                            data-i18n-skip="true"
                            style={{ 
                              backgroundColor: `${marker.color}1f`,
                              color: marker.color,
                            }}
                            title={[marker.name, marker.description].filter(Boolean).join(' — ')}
                          >
                            <span className="w-2 h-2 shrink-0 rounded-full" style={{ backgroundColor: marker.color }} />
                            <span className="max-w-40 truncate">{marker.name}</span>
                            <span className="shrink-0 font-mono text-[11px]">({marker.key})</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  )}
                  <td className={`${tableCellClass} sticky right-0 z-10 bg-white text-right`}>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => onEditSubject(s)}
                        className={btnSecondary}
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => onDeleteSubject(s)}
                        className={btnDanger}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CustomMarkersModal
        isOpen={isMarkersModalOpen}
        onClose={() => setIsMarkersModalOpen(false)}
        markers={customMarkers}
        onSave={onSaveCustomMarkers}
      />
    </>
  );
};

export default SubjectPage;
