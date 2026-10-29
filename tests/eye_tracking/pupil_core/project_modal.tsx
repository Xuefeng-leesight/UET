// Mount the actual production component; no separate imitation UI.
import React from 'react';
import { createRoot } from 'react-dom/client';
import NewProjectModal from '../../../src/features/projects/NewProjectModal';
import { createEmptyProjectDraft } from '../../../src/features/projects/domain/projectDraft';
import { createEyeTrackingModality } from '../../../shared/domain/projectModalities';
import '../../../index.css';

function Check() {
  const [draft, setDraft] = React.useState(createEmptyProjectDraft);
  const [result, setResult] = React.useState('');
  return <><NewProjectModal isOpen onClose={() => {}} newProjectData={draft} setNewProjectData={setDraft}
    onCreate={() => setResult(JSON.stringify({ ...draft, modality: createEyeTrackingModality(draft.deviceModel, draft.deviceType) }))}/>
    <output data-testid="project-result">{result}</output></>;
}
createRoot(document.getElementById('root')!).render(<Check/>);
