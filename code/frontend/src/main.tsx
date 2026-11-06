import { createRoot } from 'react-dom/client';
import SystemRoot from './system/SystemRoot';
import './styles.css';
import './system/themes.css';

createRoot(document.getElementById('root')!).render(<SystemRoot />);
