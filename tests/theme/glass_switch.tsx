import React from 'react';
import { createRoot } from 'react-dom/client';
import Switch from '../../src/shared/ui/Switch';
import ProjectSettingsPage from '../../src/features/projects/ProjectSettingsPage';
import NewProjectModal from '../../src/features/projects/NewProjectModal';
import FacialSettingToggle from '../../src/features/recording/domain/FacialSettingToggle';
import { VisualSettingsPanel } from '../../src/features/analysis/visual/VisualSettingsPanel';
import { AoiBasicSettingsPanel } from '../../src/features/analysis/aoi/AoiBasicSettingsPanel';
import { DEFAULT_MOUNTAIN_SETTINGS } from '../../src/features/analysis/visual/mountainChartContract';
import { createEmptyProjectDraft } from '../../src/features/projects/domain/projectDraft';
import { createEyeTrackingModality, createFacialExpressionModality } from '../../shared/domain/projectModalities';
import type { Project } from '../../shared/contracts/domain/models';
import '../../index.css';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') || 'glass';
document.documentElement.dataset.platform = query.get('platform') || 'windows';
const noop = () => {};
function Harness() {
  const [on, setOn] = React.useState(false);
  const [delayed, setDelayed] = React.useState(false);
  const [disabled, setDisabled] = React.useState(false);
  const [mounted, setMounted] = React.useState(true);
  const [calls, setCalls] = React.useState(0);
  const [modal, setModal] = React.useState(false);
  const [draft, setDraft] = React.useState(createEmptyProjectDraft);
  const [project, setProject] = React.useState<Project>({ id: 'ui', name: '开关回归工程', code: 'UI', manager: 'Tester', notes: '', updatedAt: '', modalities: [createEyeTrackingModality('Pro', '桌面式')] });
  const [mark, setMark] = React.useState(false);
  const [trigger, setTrigger] = React.useState(true);
  const [gaze, setGaze] = React.useState({ maxRadius: 50, borderWidth: 2, opacity: 0.5, showLines: true, showBorder: false });
  const [honeycomb, setHoneycomb] = React.useState({ cursorStyle: 'solid' as 'solid' | 'hollow' | 'cross', radius: 10, borderWidth: 2, opacity: 0.5 });
  const [mountain, setMountain] = React.useState(DEFAULT_MOUNTAIN_SETTINGS);
  const [heatmap, setHeatmap] = React.useState({ radius: 30, opacity: 0.5, intensity: 0.5 });
  const [perspective, setPerspective] = React.useState(false);
  return <main className="p-4 space-y-4">
    <div className="flex flex-wrap gap-2">
      <button onClick={() => setDisabled(v => !v)}>禁用测试开关</button>
      <button onClick={() => setMounted(v => !v)}>挂载测试开关</button>
      <button onClick={() => setModal(true)}>打开新建工程</button>
      <output data-testid="calls">{calls}</output>
    </div>
    {mounted && <section data-testid="switch-cases" className="rounded-xl p-4 flex flex-wrap items-center gap-4" style={{ backgroundColor: 'color-mix(in srgb, var(--app-surface) 90%, transparent)' }}>
      <Switch checked={on} disabled={disabled} aria-label="测试开关" onClick={() => { setOn(v => !v); setCalls(v => v + 1); }} />
      <Switch checked={false} aria-label="拒绝切换" onClick={() => setCalls(v => v + 1)} />
      <Switch checked={delayed} aria-label="延迟切换" onClick={() => setTimeout(() => setDelayed(v => !v), 80)} />
      <Switch checked={on} size="compact" aria-label="紧凑开关" onClick={() => setOn(v => !v)} />
      <Switch checked={on} size="timeline" inactiveClass="bg-emerald-600" aria-label="时间轴开关" onClick={() => setOn(v => !v)} />
      <FacialSettingToggle checked={on} onChange={setOn} disabled={disabled} title="眼图显示" description="录制设置共享开关" />
    </section>}
    <div data-testid="project" className="h-[520px] max-w-4xl">
      <ProjectSettingsPage editedProject={project} hasProjectChanges onChange={noop}
        onModalitiesChange={ids => setProject(p => ({ ...p, modalities: ids.map(id => id === 'eye-tracking' ? createEyeTrackingModality('Pro', '桌面式') : createFacialExpressionModality()) }))}
        onSave={noop} onBackup={noop} onExport={noop} onDeleteExperiment={noop} onDeleteProject={noop}
        experiments={[]} activeExperimentId="" onChangeExperiment={noop} onCreateExperiment={noop} />
    </div>
    <div className="bg-white rounded-xl p-3 w-[300px] max-w-full" data-testid="visual">
      <VisualSettingsPanel stimuli={[]} selectedStimulusId={null} isGlassesMode visualSubTab="gaze" isEn={query.has('en')}
        showMarkTrack={mark} showTriggerTrack={trigger} gazeSettings={gaze} honeycombSettings={honeycomb}
        mountainSettings={mountain} heatmapSettings={heatmap} heatmapPerspectiveEnabled={perspective}
        onSelectedStimulusIdChange={noop} onShowMarkTrackChange={setMark} onShowTriggerTrackChange={setTrigger}
        onGazeSettingsChange={setGaze} onHoneycombSettingsChange={setHoneycomb} onMountainSettingsChange={setMountain}
        onHeatmapSettingsChange={setHeatmap} onHeatmapPerspectiveEnabledChange={setPerspective} onResetMountainCamera={noop} />
    </div>
    <div className="bg-white rounded-xl p-3 w-[300px] max-w-full" data-testid="aoi">
      <AoiBasicSettingsPanel stimuli={[]} selectedStimulusId={null} isGlassesMode
        showMarkTrack={mark} showTriggerTrack={trigger} aoiFontSize={12} gridFontSize={12}
        gridEnabled={mark} gridLoading={false} gridError={null} gridMetric="fixationCount" gridMetricOptions={[]}
        gridShowValues={mark} gridShowScale={trigger} gridRows={3} gridCols={3} gridOpacity={0.5}
        aoiShowName={mark} aoiOpacity={0.5} aoiBorderWidth={2}
        onSelectedStimulusIdChange={noop} onShowMarkTrackChange={setMark} onShowTriggerTrackChange={setTrigger}
        onAoiFontSizeChange={noop} onGridFontSizeChange={noop} onGridEnabledChange={setMark} onGridMetricChange={noop}
        onGridShowValuesChange={setMark} onGridShowScaleChange={setTrigger} onGridRowsChange={noop} onGridColsChange={noop}
        onGridOpacityChange={noop} onAoiShowNameChange={setMark} onAoiOpacityChange={noop} onAoiBorderWidthChange={noop} />
    </div>
    <NewProjectModal isOpen={modal} onClose={() => setModal(false)} newProjectData={draft} setNewProjectData={setDraft} onCreate={noop} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
