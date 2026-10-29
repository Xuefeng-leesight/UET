import { useMemo, useRef, useState } from 'react';
import type { Experiment, Project, RecordingRecord, Subject, TabType, ViewType } from '@shared/contracts/domain/models';
import type { CompareResult, InsightReport } from '@shared/contracts/domain/reporting';
import type { CustomMarker, ExtendedStimulus } from '@/shared/types/mrt';

export type VisualSubTab = 'heatmap' | 'gaze' | 'honeycomb' | 'mountain';

export function useMrtWorkspaceState() {
  const [currentView, setCurrentView] = useState<ViewType>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('project-settings');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [visualSubTab, setVisualSubTab] = useState<VisualSubTab>('heatmap');
  const [visualSelectedStimulusId, setVisualSelectedStimulusId] = useState<string | null>(null);
  const [visibleRecordIds, setVisibleRecordIds] = useState<Set<string>>(() => new Set());
  const [heatmapSettings, setHeatmapSettings] = useState({ radius: 40, opacity: 0.7, intensity: 1 });

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDirs, setProjectDirs] = useState<Record<string, string>>({});
  const [dashboardSearchQuery, setDashboardSearchQuery] = useState('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [stimuli, setStimuli] = useState<ExtendedStimulus[]>([]);
  const [records, setRecords] = useState<RecordingRecord[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [activeExperimentId, setActiveExperimentId] = useState('');

  const [chartMode, setChartMode] = useState<'single' | 'compare'>('single');
  const [chartPreselectedRecordIds, setChartPreselectedRecordIds] = useState<string[]>([]);
  const [latestCompareResult, setLatestCompareResult] = useState<CompareResult | null>(null);
  const [latestInsightReport, setLatestInsightReport] = useState<InsightReport | null>(null);
  const [chartAiBusy, setChartAiBusy] = useState(false);
  const [chartAiBusyText, setChartAiBusyText] = useState('');
  const [customMarkers, setCustomMarkers] = useState<CustomMarker[]>([]);

  const [editedProject, setEditedProject] = useState<Project | null>(null);
  const [hasProjectChanges, setHasProjectChanges] = useState(false);
  const prevActiveProjectIdRef = useRef<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || null,
    [projects, activeProjectId],
  );
  const activeExperiment = useMemo(
    () => experiments.find((experiment) => experiment.id === activeExperimentId) || experiments[0] || null,
    [experiments, activeExperimentId],
  );

  return {
    currentView, setCurrentView, activeProjectId, setActiveProjectId, activeTab, setActiveTab,
    selectedRecordId, setSelectedRecordId, visualSubTab, setVisualSubTab,
    visualSelectedStimulusId, setVisualSelectedStimulusId, visibleRecordIds, setVisibleRecordIds,
    heatmapSettings, setHeatmapSettings,
    projects, setProjects, projectDirs, setProjectDirs, dashboardSearchQuery, setDashboardSearchQuery,
    subjects, setSubjects, stimuli, setStimuli, records, setRecords,
    experiments, setExperiments, activeExperimentId, setActiveExperimentId, activeExperiment,
    activeProject,
    chartMode, setChartMode, chartPreselectedRecordIds, setChartPreselectedRecordIds,
    latestCompareResult, setLatestCompareResult, latestInsightReport, setLatestInsightReport,
    chartAiBusy, setChartAiBusy, chartAiBusyText, setChartAiBusyText,
    customMarkers, setCustomMarkers,
    editedProject, setEditedProject, hasProjectChanges, setHasProjectChanges, prevActiveProjectIdRef,
  };
}
