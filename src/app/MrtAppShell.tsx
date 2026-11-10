import React from 'react';
import MrtApplicationController from './MrtApplicationController';

/** Stable renderer shell. Domain state and orchestration live behind the application controller. */
const MrtAppShell: React.FC = () => <MrtApplicationController />;

export default MrtAppShell;
