import React from 'react';
import type { ModalityId, Project, RecordingRecord } from '@shared/contracts/domain/models';
import { normalizeProjectModalities } from '@shared/domain/projectModalities';
import { recordHasModality } from '@shared/domain/recordModalities';
import { calibrationScorePresentation, parseRecordingCalibrationScores } from '@shared/domain/calibrationScores';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import CustomSelect from '@/shared/ui/CustomSelect';
import { useLanguage } from '@/app/i18n/useLanguage';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { tableCellClass, tableHeadClass, tableNumericCellClass, tableRowClass, tableSelectedRowClass } from '@/shared/ui/tableClasses';

interface RecordsListPageProps {
  records: RecordingRecord[];
  project: Project | null;
  onSelectRecord: (recordId: string, modality: ModalityId) => void;
  onDeleteRecord: (recordId: string) => void;
  onStartCompare?: (recordIds: string[]) => void;
}

function RecordingCalibrationScore({ record, isEn }: { record: RecordingRecord; isEn: boolean }) {
  const scores = parseRecordingCalibrationScores(record, record.deviceModel);
  if (!scores) return <>—</>;
  if (record.deviceModel !== 'PupilCore') {
    const result = calibrationScorePresentation(scores, false, isEn);
    return <><span title={result.left.tooltip}>{Number.isFinite(scores.left) ? scores.left.toFixed(2) : '—'}</span> : <span title={result.right.tooltip}>{Number.isFinite(scores.right) ? scores.right.toFixed(2) : '—'}</span></>;
  }
  const result = calibrationScorePresentation(scores, true, isEn);
  return <div data-i18n-skip="true">
    {!scores.pupilScores?.validation && <div className="text-[11px] font-sans text-slate-500">{result.title}</div>}
    <span title={result.left.tooltip}>{result.left.value}</span> : <span title={result.right.tooltip}>{result.right.value}</span>
  </div>;
}

const RecordsListPage: React.FC<RecordsListPageProps> = ({ records, project, onSelectRecord, onDeleteRecord, onStartCompare }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const availableModalities = React.useMemo<ModalityId[]>(
    () => project ? normalizeProjectModalities(project).map((modality) => modality.id) : ['eye-tracking'],
    [project],
  );
  const [recordModality, setRecordModality] = React.useState<ModalityId>(() => availableModalities[0] || 'eye-tracking');
  React.useEffect(() => {
    if (availableModalities.includes(recordModality)) return;
    if (availableModalities[0]) setRecordModality(availableModalities[0]);
  }, [availableModalities, recordModality]);
  const visibleRecords = React.useMemo(
    () => records.filter((record) => recordHasModality(record, recordModality)),
    [recordModality, records],
  );

  React.useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (records.some((record) => record.id === id)) next.add(id);
      }
      return next;
    });
  }, [records]);

  const toggleSelected = (recordId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(visibleRecords.map((record) => record.id)));
  };

  const clearAll = () => {
    setSelectedIds(new Set());
  };

  const startCompare = () => {
    if (!onStartCompare) return;
    onStartCompare(Array.from(selectedIds));
  };
  const eyeComparableIds = React.useMemo(() => new Set(records.filter((record) => recordHasModality(record, 'eye-tracking')).map((record) => record.id)), [records]);

  const fmt = (v: unknown, digits = 1): string => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (digits <= 0) return String(Math.round(v));
    return v.toFixed(digits);
  };

  const fmtInt = (v: unknown): string => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v <= 0) return '—';
    return String(Math.round(v));
  };

  return (
    <div className="mrt-float-list-panel h-full min-w-0 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50/60">
        <div className="mr-1 flex items-center gap-2 border-r border-slate-200 pr-3">
          <span className="text-xs font-medium text-slate-600">数据模态</span>
          <CustomSelect
            value={recordModality}
            onChange={(event) => { setRecordModality(event.target.value as ModalityId); setSelectedIds(new Set()); }}
            className="min-w-36 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none"
          >
            {availableModalities.includes('eye-tracking') && <option value="eye-tracking">眼动模块数据记录</option>}
            {availableModalities.includes('facial-expression') && <option value="facial-expression">表情模块数据记录</option>}
          </CustomSelect>
        </div>
        <button
          type="button"
          onClick={selectAll}
          className={btnSecondary}
        >
          全选
        </button>
        <button
          type="button"
          onClick={clearAll}
          className={btnSecondary}
        >
          清空
        </button>
        <span data-i18n-skip="true" className="text-xs tabular-nums text-slate-600">{isEn ? `Selected ${selectedIds.size} / ${visibleRecords.length}` : `已选 ${selectedIds.size} / ${visibleRecords.length}`}</span>
        <button
          type="button"
          onClick={startCompare}
          disabled={!onStartCompare || selectedIds.size === 0 || Array.from(selectedIds).some((id) => !eyeComparableIds.has(id))}
          className={`${btnPrimary} ml-auto`}
          title={!onStartCompare
            ? (isEn ? 'Comparison is unavailable in this view' : '当前页面不可进行记录对比')
            : selectedIds.size === 0
              ? (isEn ? 'Select eye tracking records to compare' : '请先选择需要对比的眼动记录')
              : Array.from(selectedIds).some((id) => !eyeComparableIds.has(id))
                ? (isEn ? 'Comparison requires eye tracking data for every selected record' : '所选记录均需包含眼动数据才能对比')
                : undefined}
        >
          生成多记录对比
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="mrt-float-list w-full min-w-[960px] text-left border-collapse">
          <thead>
            <tr>
              <th className={tableHeadClass}>
                选择
              </th>
              <th className={tableHeadClass}>
                记录名
              </th>
              <th className={tableHeadClass}>
                受试者
              </th>
              <th className={tableHeadClass}>
                录制时间
              </th>
              {recordModality === 'eye-tracking' ? <>
                <th className={`${tableHeadClass} text-right`}>校准得分(左:右)</th>
                <th className={`${tableHeadClass} text-right`}>实际采样率(Hz)</th>
                <th className={`${tableHeadClass} text-right`}>有效率(%)</th>
              </> : <>
                <th className={tableHeadClass}>分析状态</th>
                <th className={tableHeadClass}>表情视频</th>
                <th className={tableHeadClass}>记录状态</th>
              </>}
              <th className={`${tableHeadClass} text-right`}>
                时长(s)
              </th>
              <th className={`${tableHeadClass} text-right`}>
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRecords.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-10 text-center text-sm text-slate-500">
                  暂无记录，请先在录制模块生成数据
                </td>
              </tr>
            ) : (
              visibleRecords.map((r) => (
                <tr key={r.id} className={selectedIds.has(r.id) ? tableSelectedRowClass : tableRowClass}>
                  <td className={tableCellClass}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 align-middle accent-sky-600"
                      aria-label={isEn ? `Select ${getDisplayRecordName(r)}` : `选择 ${getDisplayRecordName(r)}`}
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleSelected(r.id)}
                    />
                  </td>
                  <td data-i18n-skip="true" className={`${tableCellClass} font-medium`}>
                    <div className="max-w-52 truncate" title={getDisplayRecordName(r)}>{getDisplayRecordName(r)}</div>
                  </td>
                  <td data-i18n-skip="true" className={tableCellClass}><div className="max-w-36 truncate" title={r.subjectName}>{r.subjectName}</div></td>
                  <td className={`${tableCellClass} whitespace-nowrap text-xs tabular-nums`}>{r.timestamp}</td>
                  {recordModality === 'eye-tracking' ? <>
                    <td className={tableNumericCellClass}><RecordingCalibrationScore record={r} isEn={isEn} /></td>
                    <td className={tableNumericCellClass}>{fmtInt(r.samplingRateHz)}</td>
                    <td className={tableNumericCellClass}>{fmt(r.validityPercent, 1)}</td>
                  </> : <>
                    <td className={`${tableCellClass} whitespace-nowrap text-xs font-medium`}>{r.modalities?.['facial-expression']?.analysisPath ? <span className="text-emerald-600">已分析</span> : <span className="text-slate-600">待分析</span>}</td>
                    <td className={`${tableCellClass} whitespace-nowrap text-xs`}>{r.modalities?.['facial-expression']?.sourcePath ? '已保存' : '缺失'}</td>
                    <td className={`${tableCellClass} whitespace-nowrap text-xs`}>{r.modalities?.['facial-expression']?.status === 'complete' ? '完整' : '部分完成'}</td>
                  </>}
                  <td className={tableNumericCellClass}>{fmt(r.durationSeconds, 1)}</td>
                  <td className={`${tableCellClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => onSelectRecord(r.id, recordModality)}
                        className={btnSecondary}
                      >
                        详情
                      </button>
                      <button
                        onClick={() => onDeleteRecord(r.id)}
                        className={btnDanger}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default RecordsListPage;
