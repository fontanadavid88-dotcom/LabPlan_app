// FIX: Corrected module imports. `flushSync` is from `react-dom` and `createRoot` is from `react-dom/client`.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

// --- INTERFACES & TYPES ---
interface InstrumentCategory {
    id: string;
    name: string;
    icon: string;
}

interface CampaignCategory {
    id: string;
    name: string;
    icon: string;
    color: string;
    keywords?: string;
}

interface Instrument {
    id: string;
    name: string;
    categoryId: string;
    location: string;
    saNumber: string;
    weight?: number;
}

interface Personnel {
    id:string;
    name: string;
    initials: string;
    workPercentage: number;
    fixedAbsences: { [day: number]: { M?: string; P?: string } };
    color: string;
    keywords?: string;
}

interface AbsenceType {
    id: string;
    name: string;
    color: string;
}

interface Absence {
    id: string;
    personnelId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
    typeId: string;
    note?: string;
}

interface UnprocessedAbsence {
    id: string;
    summary: string;
    startDate: string;
    endDate: string;
    failureReason: string;
}

interface Campaign {
    id: string;
    name: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
    categoryId: string;
    managerId?: string;
    deliveryDate?: string;
    deliveryMet?: boolean;
}

interface Booking {
    id: string;
    instrumentId: string;
    personnelId: string;
    date: string; // YYYY-MM-DD
    slot: 'M' | 'P';
    note?: string;
}

interface Template {
    id: string;
    name: string;
    // New positional structure: Key is `${instrumentId}-${dayOfWeek}-${slot}`
    positionalBookings: {
        [positionKey: string]: {
            personnelId: string;
            note?: string;
        };
    };
}

interface AppData {
    instruments: Instrument[];
    instrumentCategories: InstrumentCategory[];
    personnel: Personnel[];
    absenceTypes: AbsenceType[];
    absences: Absence[];
    unprocessedAbsences?: UnprocessedAbsence[];
    campaigns: Campaign[];
    campaignCategories: CampaignCategory[];
    bookings: Booking[];
    weeklyNotes: { [week: string]: string };
    statusOverrides: { [key: string]: string }; // key: `${personId}-${date}-${slot}`, value: absenceTypeId or 'present'
    appLogo?: string;
    templates?: Template[];
}

type View = 'dashboard' | 'dataManagement' | 'analisi';
type DataManagementTab = 'instruments' | 'instrumentCategories' | 'personnel' | 'absences' | 'absenceTypes' | 'campaigns' | 'campaignCategories' | 'backup';
type DashboardTab = 'instruments' | 'personnel';

// --- UTILITY FUNCTIONS ---
const getISOWeekYear = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    // Move the date to the Thursday of the same week
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    return d.getUTCFullYear();
};

const getISOWeek = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
};

const getWeekStartDate = (year: number, week: number): Date => {
    // January 4th is always in week 1. We'll use it as a UTC anchor.
    const d = new Date(Date.UTC(year, 0, 4));
    // Get the ISO day of week (1 for Monday, 7 for Sunday) for Jan 4th.
    const day = d.getUTCDay() || 7;
    // Calculate the UTC date of the Monday of week 1.
    d.setUTCDate(d.getUTCDate() - (day - 1));
    // Add the offset to get to the Monday of the target week.
    d.setUTCDate(d.getUTCDate() + (week - 1) * 7);
    
    // Return a new local date using the UTC components. This correctly handles timezone offsets.
    // For example, if d is 2024-10-28T00:00:00.000Z, this will create a local date
    // for 2024-10-28 at midnight in the user's timezone.
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};


const formatDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};


const addDays = (date: Date, days: number) => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
};

const addWorkingDays = (dateStr: string, days: number): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'T00:00:00'); // Ensure local timezone
    let added = 0;
    while (added < days) {
        date.setDate(date.getDate() + 1);
        const dayOfWeek = date.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = Sunday, 6 = Saturday
            added++;
        }
    }
    return formatDate(date);
};

const countWorkingDays = (start: Date, end: Date): number => {
    let count = 0;
    const current = new Date(start.valueOf());
    while (current <= end) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            count++;
        }
        current.setDate(current.getDate() + 1);
    }
    return count;
};

const parseDateFromICSLine = (line: string): string | null => {
    const dateTimePart = line.split(':').pop() || '';
    const match = dateTimePart.match(/(\d{8})/); // Just get the date part
    if (match && match[1]) {
        const dateStr = match[1];
        return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    }
    return null;
};

const parseICS = (icsContent: string): { summary: string; startDate: string; endDate: string; }[] => {
    const events: { summary: string; startDate: string; endDate: string; }[] = [];
    const unfoldedContent = icsContent.replace(/\r?\n /g, '');
    const eventBlocks = unfoldedContent.split('BEGIN:VEVENT');
    if (eventBlocks.length > 0) eventBlocks.shift();

    for (const block of eventBlocks) {
        if (block.includes('STATUS:CANCELLED')) continue;

        const eventData: Partial<{ summary: string; startDate: string; endDate: string; }> = {};
        
        const lines = block.split(/\r?\n/);
        const summaryLine = lines.find(l => l.startsWith('SUMMARY'));
        const dtstartLine = lines.find(l => l.startsWith('DTSTART'));
        const dtendLine = lines.find(l => l.startsWith('DTEND'));

        if (summaryLine) eventData.summary = summaryLine.substring(summaryLine.indexOf(':') + 1).trim();
        if (dtstartLine) eventData.startDate = parseDateFromICSLine(dtstartLine);
        
        const isAllDay = dtstartLine ? dtstartLine.includes('VALUE=DATE') : false;

        if (dtendLine) {
            const endDateStr = parseDateFromICSLine(dtendLine);
            if (endDateStr) {
                 const startDateStr = eventData.startDate;
                 // Outlook all-day event for one day has DTSTART:20240101 and DTEND:20240102
                 // We need to subtract a day from DTEND if it's an all-day event and the end date is after the start date.
                 if (isAllDay && startDateStr && endDateStr > startDateStr) {
                    const endDate = new Date(endDateStr);
                    endDate.setDate(endDate.getDate() - 1);
                    eventData.endDate = formatDate(endDate);
                 } else {
                    eventData.endDate = endDateStr;
                 }
            }
        }
        
        if (!eventData.endDate && eventData.startDate) {
            eventData.endDate = eventData.startDate;
        }

        if (eventData.summary && eventData.startDate && eventData.endDate) {
            events.push(eventData as { summary: string; startDate: string; endDate: string; });
        }
    }
    return events;
};

// FIX: Added `id: string` to the generic constraint to ensure returned items have an `id` property, resolving type errors in `CampaignManager`.
const findByKeywords = <T extends { id: string; keywords?: string }>(name: string, items: T[]): T | null => {
    const lowerCaseName = name.toLowerCase();
    for (const item of items) {
        if (item.keywords) {
            const keywords = item.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
            for (const keyword of keywords) {
                if (lowerCaseName.includes(keyword)) {
                    return item;
                }
            }
        }
    }
    return null;
};

const debounce = (func: Function, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: any[]) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func(...args);
        }, delay);
    };
};

// --- DATA & PREFERENCES PERSISTENCE ---
const LOCAL_STORAGE_KEY = 'labPlannerData';
const PREFS_KEY = 'labPlannerUserPrefs';

const loadPrefs = () => {
    try {
        const prefs = localStorage.getItem(PREFS_KEY);
        return prefs ? JSON.parse(prefs) : {};
    } catch {
        return {};
    }
};

const savePref = (key: string, value: any) => {
    try {
        const currentPrefs = loadPrefs();
        currentPrefs[key] = value;
        localStorage.setItem(PREFS_KEY, JSON.stringify(currentPrefs));
    } catch (e) {
        console.error("Failed to save preference", e);
    }
};

const initialData: AppData = {
    instruments: [],
    instrumentCategories: [],
    personnel: [],
    absenceTypes: [
        { id: 'fuori_sede', name: 'Fuori sede', color: '#ff9800' },
        { id: 'ferie', name: 'Ferie', color: '#4caf50' },
        { id: 'malattia', name: 'Malattia', color: '#f44336' },
        { id: 'telelavoro', name: 'Telelavoro', color: '#2196f3' },
        { id: 'fisse', name: 'Assenza Fissa', color: '#9e9e9e' }
    ],
    absences: [],
    unprocessedAbsences: [],
    campaigns: [],
    campaignCategories: [],
    bookings: [],
    weeklyNotes: {},
    statusOverrides: {},
    appLogo: undefined,
    templates: [],
};

const emojiToMaterialMap: Record<string, string> = {
    '🧪': 'science', '🔬': 'biotech', '💻': 'computer', '🌡️': 'thermometer',
    '⚖️': 'scale', '📈': 'monitoring', '📦': 'package',
};

// --- DEFAULT DATA FOR TESTING ---
const getDefaultData = (): AppData => {
    // Categories
    const instCat1 = { id: 'cat-inst-1', name: 'Analisi Chimica', icon: 'science' };
    const instCat2 = { id: 'cat-inst-2', name: 'Microscopia', icon: 'biotech' };
    const instCat3 = { id: 'cat-inst-3', name: 'Preparativa', icon: 'blender' };

    const campCat1 = { id: 'cat-camp-1', name: 'Ricerca e Sviluppo', icon: 'lightbulb', color: '#ff9800', keywords: 'R&S, ricerca' };
    const campCat2 = { id: 'cat-camp-2', name: 'Controllo Qualità', icon: 'verified', color: '#4caf50', keywords: 'CQ, qualità' };
    const campCat3 = { id: 'cat-camp-3', name: 'Produzione', icon: 'factory', color: '#2196f3', keywords: 'produzione, prod' };

    // Personnel
    const p1 = { id: 'p1', name: 'Mario Rossi', initials: 'MR', workPercentage: 100, fixedAbsences: {}, color: '#f44336', keywords: 'gc, hplc, chimica' };
    const p2 = { id: 'p2', name: 'Laura Bianchi', initials: 'LB', workPercentage: 80, fixedAbsences: { 4: { P: 'fisse' } }, color: '#9c27b0', keywords: 'microscopia, confocale, sem' };
    const p3 = { id: 'p3', name: 'Giuseppe Verdi', initials: 'GV', workPercentage: 100, fixedAbsences: {}, color: '#009688', keywords: 'preparativa, cappa' };
    const p4 = { id: 'p4', name: 'Anna Neri', initials: 'AN', workPercentage: 50, fixedAbsences: { 0: { M: 'fisse', P: 'fisse'}, 1: {M: 'fisse', P: 'fisse'} }, color: '#ffc107', keywords: 'hplc, dati' };

    // Instruments
    const i1 = { id: 'i1', name: 'GC-MS Agilent', categoryId: instCat1.id, location: 'L101', saNumber: 'SA-001', weight: 4 };
    const i2 = { id: 'i2', name: 'HPLC Waters', categoryId: instCat1.id, location: 'L101', saNumber: 'SA-002', weight: 3 };
    const i3 = { id: 'i3', name: 'Microscopio Confocale Leica', categoryId: instCat2.id, location: 'L102', saNumber: 'SA-003', weight: 5 };
    const i4 = { id: 'i4', name: 'Microscopio Elettronico SEM', categoryId: instCat2.id, location: 'L102', saNumber: 'SA-004', weight: 5 };
    const i5 = { id: 'i5', name: 'Cappa Chimica 1', categoryId: instCat3.id, location: 'L103', saNumber: 'SA-005', weight: 1 };
    const i6 = { id: 'i6', name: 'Stufa', categoryId: instCat3.id, location: 'L103', saNumber: 'SA-006', weight: 1 };

    // Dynamic Dates for Campaigns & Bookings
    const today = new Date();
    const currentYear = getISOWeekYear(today);
    const currentWeek = getISOWeek(today);
    const weekStart = getWeekStartDate(currentYear, currentWeek);
    
    const monday = formatDate(addDays(weekStart, 0));
    const tuesday = formatDate(addDays(weekStart, 1));
    const wednesday = formatDate(addDays(weekStart, 2));
    const thursday = formatDate(addDays(weekStart, 3));
    const friday = formatDate(addDays(weekStart, 4));

    const lastWeekStart = addDays(weekStart, -7);
    const nextWeekStart = addDays(weekStart, 7);

    // Campaigns
    const campaigns: Campaign[] = [
        { id: 'c1', name: 'Progetto Alfa (R&S)', startDate: formatDate(addDays(lastWeekStart, 2)), endDate: tuesday, categoryId: campCat1.id, managerId: p1.id, deliveryDate: addWorkingDays(tuesday, 10), deliveryMet: true },
        { id: 'c2', name: 'Analisi CQ Lotto #123', startDate: monday, endDate: friday, categoryId: campCat2.id, managerId: p4.id, deliveryDate: addWorkingDays(friday, 10) },
        { id: 'c3', name: 'Sviluppo Metodo SEM', startDate: wednesday, endDate: formatDate(addDays(nextWeekStart, 1)), categoryId: campCat1.id, managerId: p2.id, deliveryDate: addWorkingDays(formatDate(addDays(nextWeekStart, 1)), 10) },
        { id: 'c4', name: 'Manutenzione Cappe', startDate: formatDate(addDays(weekStart, -14)), endDate: formatDate(addDays(weekStart, -10)), categoryId: campCat3.id, managerId: p3.id, deliveryDate: addWorkingDays(formatDate(addDays(weekStart, -10)), 10), deliveryMet: false }
    ];

    // Bookings for current week
    const bookings: Booking[] = [
        { id: 'b1', instrumentId: i1.id, personnelId: p1.id, date: monday, slot: 'M', note: 'Calibrazione iniziale' },
        { id: 'b2', instrumentId: i1.id, personnelId: p1.id, date: monday, slot: 'P' },
        { id: 'b3', instrumentId: i2.id, personnelId: p1.id, date: tuesday, slot: 'M' },
        { id: 'b4', instrumentId: i3.id, personnelId: p2.id, date: tuesday, slot: 'M' },
        { id: 'b5', instrumentId: i3.id, personnelId: p2.id, date: tuesday, slot: 'P' },
        { id: 'b6', instrumentId: i5.id, personnelId: p3.id, date: wednesday, slot: 'M' },
        { id: 'b7', instrumentId: i4.id, personnelId: p2.id, date: thursday, slot: 'M', note: 'Campioni urgenti' },
        { id: 'b8', instrumentId: i4.id, personnelId: p2.id, date: thursday, slot: 'P' },
        { id: 'b9', instrumentId: i2.id, personnelId: p4.id, date: friday, slot: 'M' },
    ];
    
    // Absences
    const absences: Absence[] = [
        {id: 'abs1', personnelId: p3.id, startDate: wednesday, endDate: wednesday, typeId: 'fuori_sede', note: 'Corso aggiornamento'}
    ];

    // Template
    const template: Template = {
        id: 't1',
        name: 'Settimana Standard CQ',
        positionalBookings: {
            [`${i2.id}-0-M`]: { personnelId: p1.id, note: 'Controllo settimanale' }, // Monday M
            [`${i2.id}-0-P`]: { personnelId: p4.id }, // Monday P
            [`${i5.id}-2-M`]: { personnelId: p3.id }, // Wednesday M
        }
    };
    
    const weekKey = `${currentYear}-W${currentWeek}`;

    return {
        instruments: [i1, i2, i3, i4, i5, i6],
        instrumentCategories: [instCat1, instCat2, instCat3],
        personnel: [p1, p2, p3, p4],
        absenceTypes: initialData.absenceTypes,
        absences: absences,
        unprocessedAbsences: [],
        campaigns: campaigns,
        campaignCategories: [campCat1, campCat2, campCat3],
        bookings: bookings,
        weeklyNotes: { [weekKey]: 'Settimana di test. Ricordarsi di verificare la calibrazione del GC-MS.' },
        statusOverrides: {},
        appLogo: undefined,
        templates: [template],
    };
};


const loadData = (): AppData => {
    try {
        const storedData = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (storedData) {
            const parsedData = JSON.parse(storedData);

            // MIGRATION for Instruments and Categories
            if (parsedData.instruments && parsedData.instruments.some((i: any) => i.category !== undefined)) {
                const instrumentCategories = new Map<string, InstrumentCategory>();
                (parsedData.instrumentCategories || []).forEach((cat: InstrumentCategory) => instrumentCategories.set(cat.name, cat));

                parsedData.instruments.forEach((inst: any) => {
                    if (inst.category !== undefined) {
                        const categoryName = inst.category || 'Senza Categoria';
                        if (!instrumentCategories.has(categoryName)) {
                            instrumentCategories.set(categoryName, {
                                id: `cat-${Date.now()}-${instrumentCategories.size}`,
                                name: categoryName,
                                icon: emojiToMaterialMap[inst.icon] || inst.icon || 'science'
                            });
                        }
                        inst.categoryId = instrumentCategories.get(categoryName)!.id;
                        delete inst.category;
                        delete inst.icon;
                    }
                });
                parsedData.instrumentCategories = Array.from(instrumentCategories.values());
            }

            if (parsedData.personnel && Array.isArray(parsedData.personnel)) {
                parsedData.personnel = parsedData.personnel.map((p: any) => {
                    const newP = {
                        ...p,
                        initials: p.initials || '',
                        color: p.color || '#cccccc',
                        fixedAbsences: p.fixedAbsences || {}
                    };
                    if (Array.isArray(newP.fixedAbsences)) { // Migration logic for fixedAbsences
                        const migratedAbsences: { [day: number]: { M: string; P: string } } = {};
                        (newP.fixedAbsences as number[]).forEach(dayIndex => {
                            migratedAbsences[dayIndex] = { M: 'fisse', P: 'fisse' };
                        });
                        newP.fixedAbsences = migratedAbsences;
                    }
                    return newP;
                });
            }
             if (parsedData.absences && Array.isArray(parsedData.absences)) {
                parsedData.absences = parsedData.absences.map((a: any) => ({
                    ...a,
                    typeId: a.typeId || (a.reason ? 'malattia' : 'ferie'),
                    note: a.note || a.reason || ''
                }));
            }
            
            const data = { ...initialData, ...parsedData };
            data.statusOverrides = parsedData.statusOverrides || {};
            data.appLogo = parsedData.appLogo || undefined;
            data.templates = parsedData.templates || [];
            data.unprocessedAbsences = parsedData.unprocessedAbsences || [];

            if (data.templates && data.templates.some(t => t.hasOwnProperty('bookings'))) {
                 console.log("Migrating old template format...");
                 data.templates = data.templates.map((t: any) => {
                     if (t.bookings) {
                         const positionalBookings: Template['positionalBookings'] = {};
                         t.bookings.forEach((b: any) => {
                            if (b.instrumentId && b.dayOfWeek !== undefined && b.slot && b.personnelId) {
                                const key = `${b.instrumentId}-${b.dayOfWeek}-${b.slot}`;
                                positionalBookings[key] = { personnelId: b.personnelId, note: b.note };
                            }
                         });
                         return { id: t.id, name: t.name, positionalBookings };
                     }
                     return t;
                 });
            }


            if (!data.absenceTypes || data.absenceTypes.length < 5) {
                data.absenceTypes = initialData.absenceTypes;
            }
            
            data.campaigns = data.campaigns.map(c => ({...c, categoryId: c.categoryId || ''}));
            data.instruments = data.instruments.map(i => ({...i, categoryId: i.categoryId || ''}));

            return data;
        }
    } catch (error) {
        console.error("Failed to load data from localStorage", error);
    }
    return getDefaultData();
};

const saveData = (data: AppData) => {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        console.error("Failed to save data to localStorage", error);
    }
};

// --- MODAL COMPONENTS ---
const ConfirmationModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    children: React.ReactNode;
}> = ({ isOpen, onClose, onConfirm, title, children }) => {
    if (!isOpen) return null;

    const handleConfirm = () => {
        onConfirm();
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{title}</h2>
                </div>
                <div className="modal-body">
                    {children}
                </div>
                <div className="modal-footer">
                    <div></div>
                    <div>
                        <button className="btn btn-secondary" onClick={onClose}>Annulla</button>
                        <button className="btn btn-danger" onClick={handleConfirm}>Conferma</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const AlertModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}> = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{title}</h2>
                </div>
                <div className="modal-body">
                    {children}
                </div>
                <div className="modal-footer" style={{justifyContent: 'flex-end'}}>
                    <div>
                        <button className="btn btn-primary" onClick={onClose}>OK</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const PromptModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (value: string) => void;
    title: string;
    message: string;
}> = ({ isOpen, onClose, onConfirm, title, message }) => {
    if (!isOpen) return null;
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 100);
            setValue('');
            setError('');
        }
    }, [isOpen]);

    const handleConfirmClick = () => {
        if (value.trim() === '') {
            setError('Il nome non può essere vuoto.');
            return;
        }
        onConfirm(value.trim());
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{title}</h2>
                </div>
                <div className="modal-body">
                    <p>{message}</p>
                    <div className="input-group">
                        <input
                            ref={inputRef}
                            type="text"
                            className="input-field"
                            value={value}
                            onChange={(e) => {
                                setValue(e.target.value);
                                if (error) setError('');
                            }}
                            onKeyPress={(e) => e.key === 'Enter' && handleConfirmClick()}
                        />
                        {error && <p className="text-danger" style={{marginTop: '0.5rem', marginBottom: 0}}>{error}</p>}
                    </div>
                </div>
                <div className="modal-footer">
                    <div></div>
                    <div>
                        <button className="btn btn-secondary" onClick={onClose}>Annulla</button>
                        <button className="btn btn-primary" onClick={handleConfirmClick}>Salva</button>
                    </div>
                </div>
            </div>
        </div>
    );
};


const ReadOnlyBanner: React.FC = () => (
    <div className="readonly-banner">
        <span className="material-symbols-outlined">visibility</span>
        MODALITÀ SOLA LETTURA
    </div>
);

// --- MAIN APP COMPONENT ---
const App: React.FC = () => {
    const [isReadOnly, setIsReadOnly] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'readonly');

    const [data, setData] = useState<AppData>(() => {
        if (new URLSearchParams(window.location.search).get('mode') === 'readonly') {
            const hash = window.location.hash.substring(1);
            if (hash.startsWith('data=')) {
                try {
                    const encodedData = hash.substring(5);
                    const jsonString = decodeURIComponent(escape(atob(encodedData)));
                    const parsedData = JSON.parse(jsonString);
                    return { ...initialData, ...parsedData };
                } catch (e) {
                    console.error("Failed to parse data from URL", e);
                }
            }
        }
        return loadData();
    });

    const [view, setView] = useState<View>('dashboard');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<{
        instruments: Instrument[];
        personnel: Personnel[];
        campaigns: Campaign[];
    } | null>(null);
    const searchContainerRef = useRef<HTMLDivElement>(null);
    const logoUploadRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isReadOnly) {
            saveData(data);
        }
    }, [data, isReadOnly]);
    
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
                setSearchResults(null);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const handleDataChange = <K extends keyof AppData>(key: K, value: AppData[K]) => {
        setData(prevData => ({ ...prevData, [key]: value }));
    };

    const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isReadOnly) return;
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                handleDataChange('appLogo', event.target?.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const triggerLogoUpload = () => {
        if (isReadOnly) return;
        logoUploadRef.current?.click();
    };
    
    const performSearch = useCallback((query: string) => {
        if (query.trim().length < 2) {
            setSearchResults(null);
            return;
        }
        const lowerQuery = query.toLowerCase();

        const foundInstruments = data.instruments.filter(i =>
            i.name.toLowerCase().includes(lowerQuery)
        );
        const foundPersonnel = data.personnel.filter(p =>
            p.name.toLowerCase().includes(lowerQuery)
        );
        const foundCampaigns = data.campaigns.filter(c => {
            if (c.name.toLowerCase().includes(lowerQuery)) {
                return true;
            }
            const category = data.campaignCategories.find(cat => cat.id === c.categoryId);
            if (category && category.keywords) {
                return category.keywords.toLowerCase().includes(lowerQuery);
            }
            return false;
        });

        if (foundInstruments.length > 0 || foundPersonnel.length > 0 || foundCampaigns.length > 0) {
            setSearchResults({
                instruments: foundInstruments,
                personnel: foundPersonnel,
                campaigns: foundCampaigns,
            });
        } else {
            setSearchResults({ instruments: [], personnel: [], campaigns: [] }); // No results found
        }
    }, [data]);

    const debouncedSearch = useMemo(() => debounce(performSearch, 300), [performSearch]);

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        setSearchQuery(query);
        debouncedSearch(query);
    };
    
    const handleShare = () => {
        try {
            const dataString = JSON.stringify(data);
            const encodedData = btoa(unescape(encodeURIComponent(dataString)));
            const url = `${window.location.origin}${window.location.pathname}?mode=readonly#data=${encodedData}`;
            navigator.clipboard.writeText(url).then(() => {
                alert('Link di condivisione in sola lettura copiato negli appunti!');
            }, () => {
                alert('Impossibile copiare il link.');
            });
        } catch (e) {
            console.error("Share error:", e);
            alert('Errore durante la creazione del link di condivisione. I dati potrebbero essere troppo grandi.');
        }
    };

    return (
        <div className={isReadOnly ? 'readonly-mode' : ''}>
            {isReadOnly && <ReadOnlyBanner />}
            <header className="app-header">
                <div className="title-container">
                    <div className="logo-container" onClick={triggerLogoUpload} title="Cambia logo">
                        {data.appLogo ? (
                            <img src={data.appLogo} alt="App Logo" className="app-logo" />
                        ) : (
                            <div className="logo-placeholder">
                                <span className="material-symbols-outlined">add_photo_alternate</span>
                            </div>
                        )}
                        <input type="file" ref={logoUploadRef} onChange={handleLogoUpload} style={{ display: 'none' }} accept="image/*" />
                    </div>
                    <h1>Planner Laboratorio</h1>
                </div>
                <div className="global-search-container" ref={searchContainerRef}>
                    <span className="material-symbols-outlined search-icon">search</span>
                    <input
                        type="text"
                        className="global-search-input"
                        placeholder="Cerca strumento, personale, campagna..."
                        value={searchQuery}
                        onChange={handleSearchChange}
                        onFocus={() => { if (searchQuery.trim().length > 1) performSearch(searchQuery); }}
                    />
                    {searchResults && (
                        <div className="search-results-dropdown">
                            {searchResults.instruments.length > 0 && (
                                <div className="search-result-group">
                                    <h6>Strumenti</h6>
                                    <ul>
                                        {searchResults.instruments.map(item => (
                                            <li key={item.id} className="search-result-item" onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                                                <span className="material-symbols-outlined">{data.instrumentCategories.find(c => c.id === item.categoryId)?.icon || 'science'}</span>
                                                {item.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {searchResults.personnel.length > 0 && (
                                 <div className="search-result-group">
                                    <h6>Personale</h6>
                                     <ul>
                                        {searchResults.personnel.map(item => (
                                            <li key={item.id} className="search-result-item" onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                                                <span className="material-symbols-outlined">person</span>
                                                {item.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {searchResults.campaigns.length > 0 && (
                                 <div className="search-result-group">
                                    <h6>Campagne</h6>
                                     <ul>
                                        {searchResults.campaigns.map(item => (
                                            <li key={item.id} className="search-result-item" onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                                                <span className="material-symbols-outlined">{data.campaignCategories.find(c => c.id === item.categoryId)?.icon || 'campaign'}</span>
                                                {item.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <nav className="nav-buttons">
                    <button onClick={() => setView('dashboard')} className={view === 'dashboard' ? 'active' : ''}>Dashboard</button>
                    {!isReadOnly && <button onClick={() => setView('analisi')} className={view === 'analisi' ? 'active' : ''}>Analisi</button>}
                    {!isReadOnly && <button onClick={() => setView('dataManagement')} className={view === 'dataManagement' ? 'active' : ''}>Anagrafica</button>}
                    <button onClick={handleShare} className="btn-share" title="Condividi in sola lettura">
                        <span className="material-symbols-outlined">share</span>
                    </button>
                </nav>
            </header>
            <main className="app-container">
                {view === 'dashboard' && (
                    <DashboardView
                        data={data}
                        setData={setData}
                        isReadOnly={isReadOnly}
                    />
                )}
                {view === 'dataManagement' && !isReadOnly && (
                    <DataManagementView
                        data={data}
                        onDataChange={handleDataChange}
                        setFullData={setData}
                    />
                )}
                {view === 'analisi' && !isReadOnly && (
                    <AnalysisView data={data} setData={setData} />
                )}
            </main>
        </div>
    );
};

// --- ANALYSIS VIEW ---
const AnalysisView: React.FC<{ data: AppData; setData: React.Dispatch<React.SetStateAction<AppData>> }> = ({ data, setData }) => {
    type PeriodType = 'month' | 'quarter' | 'year';
    const [periodType, setPeriodType] = useState<PeriodType>('month');
    const [currentDate, setCurrentDate] = useState(new Date());

    const { startDate, endDate, label } = useMemo(() => {
        const d = new Date(currentDate);
        let start: Date, end: Date, lbl: string;

        switch (periodType) {
            case 'month':
                start = new Date(d.getFullYear(), d.getMonth(), 1);
                end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
                lbl = d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
                break;
            case 'quarter':
                const quarter = Math.floor(d.getMonth() / 3);
                start = new Date(d.getFullYear(), quarter * 3, 1);
                end = new Date(d.getFullYear(), quarter * 3 + 3, 0);
                lbl = `T${quarter + 1} ${d.getFullYear()}`;
                break;
            case 'year':
                start = new Date(d.getFullYear(), 0, 1);
                end = new Date(d.getFullYear(), 11, 31);
                lbl = d.getFullYear().toString();
                break;
        }
        return { startDate: start, endDate: end, label: lbl };
    }, [currentDate, periodType]);

    const changeDate = (direction: number) => {
        const d = new Date(currentDate);
        switch (periodType) {
            case 'month': d.setMonth(d.getMonth() + direction); break;
            case 'quarter': d.setMonth(d.getMonth() + direction * 3); break;
            case 'year': d.setFullYear(d.getFullYear() + direction); break;
        }
        setCurrentDate(d);
    };

    return (
        <div>
            <div className="card">
                 <div className="d-flex justify-between align-center">
                    <button className="btn btn-secondary" onClick={() => changeDate(-1)}>&larr; Precedente</button>
                    <div className="text-center">
                        <h2 className="mb-0">{label.toUpperCase()}</h2>
                    </div>
                    <button className="btn btn-secondary" onClick={() => changeDate(1)}>Successivo &rarr;</button>
                </div>
                <div className="nav-buttons" style={{ justifyContent: 'center', marginTop: '1rem' }}>
                    <button onClick={() => setPeriodType('month')} className={periodType === 'month' ? 'active' : ''}>Mese</button>
                    <button onClick={() => setPeriodType('quarter')} className={periodType === 'quarter' ? 'active' : ''}>Trimestre</button>
                    <button onClick={() => setPeriodType('year')} className={periodType === 'year' ? 'active' : ''}>Anno</button>
                </div>
            </div>
            <div className="kpi-grid">
                {data.personnel.map(person => (
                    <PersonnelKpiCard 
                        key={person.id}
                        person={person}
                        data={data}
                        setData={setData}
                        startDate={startDate}
                        endDate={endDate}
                    />
                ))}
            </div>
        </div>
    );
};

const PersonnelKpiCard: React.FC<{ person: Personnel, data: AppData, setData: React.Dispatch<React.SetStateAction<AppData>>, startDate: Date, endDate: Date }> = ({ person, data, setData, startDate, endDate }) => {
    
    const handleDeliveryCheck = (campaignId: string, checked: boolean) => {
        setData(prevData => ({
            ...prevData,
            campaigns: prevData.campaigns.map(c => 
                c.id === campaignId ? { ...c, deliveryMet: checked } : c
            )
        }));
    };
    
    const { workload, deliveries, absences, managedCampaigns, workloadStatus } = useMemo(() => {
        const startStr = formatDate(startDate);
        const endStr = formatDate(endDate);

        // Workload calculation
        const personBookings = data.bookings.filter(b => b.personnelId === person.id && b.date >= startStr && b.date <= endStr);
        const actualWorkload = personBookings.reduce((sum, booking) => {
            const instrument = data.instruments.find(i => i.id === booking.instrumentId);
            return sum + (instrument?.weight || 1);
        }, 0);
        
        const workingDaysInPeriod = countWorkingDays(startDate, endDate);
        const maxWorkload = workingDaysInPeriod * 8 * (person.workPercentage / 100);
        const workloadPercentage = (actualWorkload / (maxWorkload || 1)) * 100;
        
        let status: { color: string, label: string };
        if (workloadPercentage > 105) {
            status = { color: '#EA4335', label: 'Sovraccarico' };
        } else if (workloadPercentage > 90) {
            status = { color: '#FBBC05', label: 'A Rischio' };
        } else if (workloadPercentage >= 40) {
            status = { color: '#34A853', label: 'Bilanciato' };
        } else {
            status = { color: '#4285F4', label: 'Sottoutilizzato' };
        }

        // Deliveries calculation
        const campaignsInPeriod = data.campaigns.filter(c => c.managerId === person.id && c.endDate >= startStr && c.endDate <= endStr);
        const evaluatedCampaigns = campaignsInPeriod.filter(c => c.deliveryMet !== undefined);
        const onTimeCampaigns = evaluatedCampaigns.filter(c => c.deliveryMet === true).length;
        const deliveryRate = evaluatedCampaigns.length > 0 ? (onTimeCampaigns / evaluatedCampaigns.length) * 100 : 100;

        // Absences
        const absenceSummary: { [key: string]: number } = {};
        const personAbsences = data.absences.filter(a => a.personnelId === person.id && a.endDate >= startStr && a.startDate <= endStr);
        
        personAbsences.forEach(absence => {
            let current = new Date(absence.startDate > startStr ? absence.startDate + 'T00:00:00' : startDate);
            const last = new Date(absence.endDate < endStr ? absence.endDate + 'T00:00:00' : endDate);
            
            while(current <= last) {
                const dayOfWeek = current.getDay();
                if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Count only weekdays
                    if (!absenceSummary[absence.typeId]) {
                        absenceSummary[absence.typeId] = 0;
                    }
                    absenceSummary[absence.typeId]++;
                }
                current.setDate(current.getDate() + 1);
            }
        });
        
        return { 
            workload: { actual: actualWorkload, max: maxWorkload }, 
            deliveries: { rate: deliveryRate, count: evaluatedCampaigns.length }, 
            absences: absenceSummary, 
            managedCampaigns: campaignsInPeriod,
            workloadStatus: status
        };
    }, [person, data, startDate, endDate]);

    return (
        <div className="kpi-card">
            <h3 className="kpi-card-header">
                <span 
                    className="status-light" 
                    style={{ backgroundColor: workloadStatus.color }}
                    title={`Stato Carico: ${workloadStatus.label}`}
                ></span>
                {person.name}
            </h3>
            <div className="kpi-item">
                <label>Carico di Lavoro</label>
                <div className="kpi-bar-container">
                    <div className="kpi-bar" style={{ width: `${Math.min(100, (workload.actual / (workload.max || 1)) * 100)}%`, backgroundColor: workloadStatus.color }}></div>
                </div>
                <span className="kpi-value">{workload.actual} Punti-Slot su {workload.max.toFixed(0)} ({((workload.actual / (workload.max || 1)) * 100).toFixed(0)}%)</span>
            </div>
            <div className="kpi-item">
                <label>Rispetto Consegne</label>
                <div className="kpi-bar-container">
                    <div className="kpi-bar" style={{ width: `${deliveries.rate}%`, backgroundColor: 'var(--accent-color)'}}></div>
                </div>
                <span className="kpi-value">{deliveries.rate.toFixed(0)}% ({deliveries.count} campagne valutate)</span>
                 {managedCampaigns.length > 0 && (
                    <div className="delivery-checklist">
                        {managedCampaigns.map(c => (
                            <label key={c.id} className="delivery-check-item">
                                <input 
                                    type="checkbox" 
                                    checked={c.deliveryMet === true}
                                    onChange={(e) => handleDeliveryCheck(c.id, e.target.checked)}
                                />
                                {c.name}
                                <span className="delivery-date"> (Fine: {new Date(c.endDate + 'T00:00:00').toLocaleDateString('it-IT')})</span>
                            </label>
                        ))}
                    </div>
                 )}
            </div>
            <div className="kpi-item">
                <label>Riepilogo Assenze</label>
                {Object.keys(absences).length > 0 ? (
                    <ul className="kpi-absence-list">
                        {Object.entries(absences).map(([typeId, count]) => {
                            const type = data.absenceTypes.find(at => at.id === typeId);
                            return <li key={typeId}><span className="color-dot" style={{backgroundColor: type?.color}}></span>{type?.name}: <strong>{count} gg</strong></li>
                        })}
                    </ul>
                ) : (
                    <p className="kpi-no-data">Nessuna assenza nel periodo.</p>
                )}
            </div>
        </div>
    );
}


// --- NEW PERSONNEL VIEW COMPONENTS ---

const QuickAddBookingModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSave: (booking: Booking) => void;
    personnel: Personnel;
    instrumentList: Instrument[];
    date: string;
    slot: 'M' | 'P';
    isPersonAbsent: (personnelId: string, date: string, slot: 'M' | 'P') => boolean;
}> = ({ isOpen, onClose, onSave, personnel, instrumentList, date, slot, isPersonAbsent }) => {
    const [instrumentId, setInstrumentId] = useState('');
    const [note, setNote] = useState('');
    const isAbsent = isPersonAbsent(personnel.id, date, slot);

    useEffect(() => {
        if (isOpen) {
            setInstrumentId('');
            setNote('');
        }
    }, [isOpen]);

    const handleSave = () => {
        if (!instrumentId) {
            alert("Selezionare lo strumento.");
            return;
        }
        if (isAbsent) {
            if (!confirm("Attenzione: la persona selezionata risulta assente. Continuare con la prenotazione?")) {
                return;
            }
        }
        onSave({
            id: Date.now().toString(),
            instrumentId,
            personnelId: personnel.id,
            date,
            slot,
            note
        });
    };
    
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Nuova Prenotazione</h2>
                    <p>{new Date(date + 'T00:00:00').toLocaleString('it-IT', {weekday: 'long', day: 'numeric', month: 'long'})} - Slot: {slot === 'M' ? 'Mattina' : 'Pomeriggio'}</p>
                </div>
                <div className="modal-body">
                    <div className="input-group">
                        <label>Assegnato a:</label>
                        <p style={{fontWeight: 'bold', margin: 0}}>{personnel.name}</p>
                        {isAbsent && <div className="alert-message alert-danger">Attenzione: Questa persona risulta assente in questo slot.</div>}
                    </div>
                    <div className="input-group">
                        <label htmlFor="instrument">Strumento:</label>
                        <select
                            id="instrument"
                            className="select-field"
                            value={instrumentId}
                            onChange={(e) => setInstrumentId(e.target.value)}
                        >
                            <option value="">Seleziona strumento...</option>
                            {instrumentList.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </select>
                    </div>
                    <div className="input-group">
                        <label htmlFor="note-quick">Nota (opzionale):</label>
                        <textarea
                            id="note-quick"
                            className="textarea-field"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                        />
                    </div>
                </div>
                <div className="modal-footer">
                     <div></div>
                    <div>
                        <button className="btn btn-secondary" onClick={onClose}>Annulla</button>
                        <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const PersonnelScheduleCell: React.FC<{
    person: Personnel,
    date: Date,
    slot: 'M' | 'P',
    data: AppData,
    getAbsenceDetails: (personnelId: string, date: Date, slot: 'M' | 'P') => AbsenceType | null,
    onAddBooking: (details: { personnelId: string, date: string, slot: 'M' | 'P' }) => void;
    isReadOnly: boolean;
}> = ({ person, date, slot, data, getAbsenceDetails, onAddBooking, isReadOnly }) => {
    const dateStr = formatDate(date);
    const key = `${person.id}-${dateStr}-${slot}`;
    const overrideTypeId = data.statusOverrides[key];
    
    let absenceDetails: AbsenceType | null = null;
    let content: React.ReactNode = null;
    let style: React.CSSProperties = {};
    let className = `personnel-schedule-cell ${slot === 'P' ? 'afternoon' : ''}`;
    let isClickable = false;
    let tooltipTitle = '';

    if (overrideTypeId) {
        if (overrideTypeId !== 'present') {
            absenceDetails = data.absenceTypes.find(at => at.id === overrideTypeId) || null;
        }
    } else {
        absenceDetails = getAbsenceDetails(person.id, date, slot);
    }
    
    if (absenceDetails) {
        style = { backgroundColor: absenceDetails.color };
        content = absenceDetails.name;
        className += ' absent';
    } else {
        const bookings = data.bookings.filter(b => b.personnelId === person.id && b.date === dateStr && b.slot === slot);
        if (bookings.length > 0) {
            const instrumentNames = bookings.map(b => data.instruments.find(i => i.id === b.instrumentId)?.name).filter(Boolean);
            tooltipTitle = instrumentNames.join('\n');
            style = { backgroundColor: person.color };

            if (bookings.length === 1) {
                const booking = bookings[0];
                const instrument = data.instruments.find(i => i.id === booking.instrumentId);
                content = (
                    <>
                        <span className="instrument-name">{instrument?.name}</span>
                        {booking.note && (
                             <svg className="note-indicator" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                <title>{booking.note}</title>
                                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"></path>
                            </svg>
                        )}
                    </>
                );
            } else {
                content = `${bookings.length} Strumenti`;
            }

            className += ' booked';
        } else {
            // Free slot
            if (!isReadOnly) isClickable = true;
            className += ' free';
        }
    }

    return (
        <td
            style={style}
            className={className}
            onClick={isClickable ? () => onAddBooking({ personnelId: person.id, date: dateStr, slot }) : undefined}
            title={tooltipTitle}
        >
            {content}
        </td>
    );
};

const PersonnelScheduleView: React.FC<{
    data: AppData;
    weekDates: Date[];
    getAbsenceDetails: (personnelId: string, date: Date, slot: 'M' | 'P') => AbsenceType | null;
    onAddBooking: (details: { personnelId: string, date: string, slot: 'M' | 'P' }) => void;
    isReadOnly: boolean;
}> = ({ data, weekDates, getAbsenceDetails, onAddBooking, isReadOnly }) => {
    return (
        <div className="card">
            <h3>🧑‍💼 PIANIFICAZIONE PERSONALE</h3>
            <table className="data-table personnel-schedule-table">
                <thead>
                    <tr>
                        <th className="main-col-personnel" rowSpan={2}>PERSONALE</th>
                        <th className="initials-col" rowSpan={2}>SIGLA</th>
                        <th className="percentage-col" rowSpan={2}>%</th>
                        {weekDates.map(date => <th key={date.toISOString()} colSpan={2}>{date.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric' })}</th>)}
                    </tr>
                    <tr>
                        {weekDates.map(date => (
                            <React.Fragment key={date.toISOString()}>
                                <th className="slot-header">M</th>
                                <th className="slot-header afternoon">P</th>
                            </React.Fragment>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.personnel.map(person => (
                        <tr key={person.id}>
                            <td className="main-col-personnel">{person.name}</td>
                            <td className="initials-col text-center">{person.initials}</td>
                            <td className="percentage-col text-center">{person.workPercentage}</td>
                            {weekDates.map(date => (
                                <React.Fragment key={date.toISOString()}>
                                    <PersonnelScheduleCell
                                        person={person}
                                        date={date}
                                        slot="M"
                                        data={data}
                                        getAbsenceDetails={getAbsenceDetails}
                                        onAddBooking={onAddBooking}
                                        isReadOnly={isReadOnly}
                                    />
                                    <PersonnelScheduleCell
                                        person={person}
                                        date={date}
                                        slot="P"
                                        data={data}
                                        getAbsenceDetails={getAbsenceDetails}
                                        onAddBooking={onAddBooking}
                                        isReadOnly={isReadOnly}
                                    />
                                </React.Fragment>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

// --- DASHBOARD VIEW ---
interface DashboardViewProps {
    data: AppData;
    setData: React.Dispatch<React.SetStateAction<AppData>>;
    isReadOnly: boolean;
}

const DashboardView: React.FC<DashboardViewProps> = ({ data, setData, isReadOnly }) => {
    const [currentDate, setCurrentDate] = useState(() => {
        const prefs = loadPrefs();
        return prefs.lastViewedDate ? new Date(prefs.lastViewedDate + 'T00:00:00') : new Date();
    });
    const [dashboardTab, setDashboardTab] = useState<DashboardTab>(() => loadPrefs().dashboardTab || 'instruments');
    const [bookingModal, setBookingModal] = useState<{ instrumentId: string; date: string; slot: 'M' | 'P' } | null>(null);
    const [quickBookingModal, setQuickBookingModal] = useState<{ personnelId: string; date: string; slot: 'M' | 'P' } | null>(null);
    const [editingStatus, setEditingStatus] = useState<{ key: string, top: number, left: number } | null>(null);
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
    const [personnelFilter, setPersonnelFilter] = useState<string>(() => loadPrefs().personnelFilter || '');
    
    const [isNamingTemplate, setIsNamingTemplate] = useState(false);
    const [alertMessage, setAlertMessage] = useState('');
    const [confirmation, setConfirmation] = useState<{
        title: string;
        message: React.ReactNode;
        onConfirm: () => void;
    } | null>(null);
    
    useEffect(() => {
        savePref('lastViewedDate', formatDate(currentDate));
    }, [currentDate]);

    useEffect(() => {
        savePref('dashboardTab', dashboardTab);
    }, [dashboardTab]);

    useEffect(() => {
        savePref('personnelFilter', personnelFilter);
    }, [personnelFilter]);


    const year = getISOWeekYear(currentDate);
    const week = getISOWeek(currentDate);
    const weekStartDate = getWeekStartDate(year, week);
    const weekDates = useMemo(() => Array.from({ length: 5 }).map((_, i) => addDays(weekStartDate, i)), [weekStartDate]);
    const weekKey = `${year}-W${week}`;
    
    const getAbsenceDetails = useCallback((personnelId: string, date: Date, slot: 'M' | 'P'): AbsenceType | null => {
        const person = data.personnel.find(p => p.id === personnelId);
        if (!person) return null;

        // 1. Check for planned absences (full day)
        const dateStr = formatDate(date);
        const absence = data.absences.find(abs =>
            abs.personnelId === personnelId &&
            dateStr >= abs.startDate &&
            dateStr <= abs.endDate
        );
        if (absence) {
            return data.absenceTypes.find(at => at.id === absence.typeId) || null;
        }

        // 2. Check for fixed absences (slot specific)
        const dayOfWeek = date.getDay(); // Sunday = 0, Monday = 1...
        const fixedAbsenceDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Mon=0
        
        const fixedAbsenceTypeId = person.fixedAbsences?.[fixedAbsenceDayIndex]?.[slot];
        if (fixedAbsenceTypeId) {
            return data.absenceTypes.find(at => at.id === fixedAbsenceTypeId) || null;
        }

        return null;
    }, [data.personnel, data.absences, data.absenceTypes]);


    const handleSaveBooking = (booking: Booking) => {
        setData(prev => ({
            ...prev,
            bookings: [...prev.bookings.filter(b => b.id !== booking.id), booking]
        }));
        setBookingModal(null);
        setQuickBookingModal(null);
    };

    const handleDeleteBooking = (bookingId: string) => {
        setData(prev => ({
            ...prev,
            bookings: prev.bookings.filter(b => b.id !== bookingId)
        }));
        setBookingModal(null);
    };
    
    const setWeeklyNote = (note: string) => {
        setData(prev => ({
            ...prev,
            weeklyNotes: { ...prev.weeklyNotes, [weekKey]: note }
        }));
    };
    
    const handleStatusChange = (key: string, typeId: string) => {
        setData(prev => {
            const newOverrides = { ...prev.statusOverrides };
            if (typeId === 'reset') {
                delete newOverrides[key];
            } else {
                newOverrides[key] = typeId;
            }
            return { ...prev, statusOverrides: newOverrides };
        });
        setEditingStatus(null);
    };

    const executeSaveTemplate = (templateName: string) => {
        const weekDateStrings = weekDates.map(formatDate);
        const bookingsInWeek = data.bookings.filter(b => weekDateStrings.includes(b.date));
        
        const newPositionalBookings: Template['positionalBookings'] = {};
        bookingsInWeek.forEach(booking => {
            const dayOfWeek = weekDateStrings.indexOf(booking.date);
            if (dayOfWeek !== -1) {
                const key = `${booking.instrumentId}-${dayOfWeek}-${booking.slot}`;
                newPositionalBookings[key] = {
                    personnelId: booking.personnelId,
                    note: booking.note,
                };
            }
        });
    
        const newTemplate: Template = {
            id: `${Date.now()}-${Math.random()}`,
            name: templateName,
            positionalBookings: newPositionalBookings,
        };
    
        setData(prev => ({
            ...prev,
            templates: [...(prev.templates || []), newTemplate],
        }));
        
        setIsNamingTemplate(false);
        setAlertMessage(`Template "${templateName}" salvato!`);
    };

    const handleSaveTemplate = () => {
        const weekDateStrings = weekDates.map(formatDate);
        const bookingsInWeek = data.bookings.filter(b => weekDateStrings.includes(b.date));
    
        if (bookingsInWeek.length === 0) {
            setConfirmation({
                title: 'Salva Template Vuoto',
                message: <p>Nessuna prenotazione trovata in questa settimana. Vuoi salvare un template vuoto?</p>,
                onConfirm: () => setIsNamingTemplate(true),
            });
        } else {
            setIsNamingTemplate(true);
        }
    };

    const executeApplyTemplate = () => {
        const template = data.templates?.find(t => t.id === selectedTemplateId);
        if (!template) return;

        const weekDateStrings = weekDates.map(formatDate);
        const bookingsOutsideWeek = data.bookings.filter(b => !weekDateStrings.includes(b.date));

        const newBookingsFromTemplate: Booking[] = Object.entries(template.positionalBookings).map(([key, value]) => {
            const [instrumentId, dayOfWeekStr, slot] = key.split('-');
            const dayOfWeek = parseInt(dayOfWeekStr, 10);
            const date = addDays(weekStartDate, dayOfWeek);

            // FIX: Explicitly cast `value` to its expected type to resolve TypeScript errors on `personnelId` and `note`.
            const bookingDetails = value as {personnelId: string, note?: string};

            return {
                id: `${Date.now()}-${Math.random()}`,
                instrumentId,
                personnelId: bookingDetails.personnelId,
                date: formatDate(date),
                slot: slot as 'M' | 'P',
                note: bookingDetails.note,
            };
        });

        setData(prev => ({
            ...prev,
            bookings: [...bookingsOutsideWeek, ...newBookingsFromTemplate],
        }));
    };

    const handleApplyTemplate = () => {
        if (!selectedTemplateId) {
            setAlertMessage("Seleziona un template da applicare.");
            return;
        }
        
        setConfirmation({
            title: 'Applica Template',
            message: <p>Applicando questo template, tutte le prenotazioni della settimana corrente verranno sostituite. Continuare?</p>,
            onConfirm: executeApplyTemplate,
        });
    };
    
    const executeDeleteTemplate = (templateIdToDelete: string) => {
        setData(prev => ({
            ...prev,
            templates: (prev.templates || []).filter(t => t.id !== templateIdToDelete),
        }));
        
        if (selectedTemplateId === templateIdToDelete) {
            setSelectedTemplateId('');
        }
    };

    const weeklyBookingsWithNotes = useMemo(() => {
        const startDateStr = formatDate(weekDates[0]);
        const endDateStr = formatDate(weekDates[4]);
        return data.bookings.filter(b => {
            if (!b.note) return false;
            return b.date >= startDateStr && b.date <= endDateStr;
        });
    }, [data.bookings, weekDates]);

    const notesByPerson = useMemo(() => {
        return weeklyBookingsWithNotes.reduce<Record<string, { name: string; notes: Booking[] }>>((acc, booking) => {
            const person = data.personnel.find(p => p.id === booking.personnelId);
            if (!person) return acc;
            if (!acc[person.id]) {
                acc[person.id] = { name: person.name, notes: [] };
            }
            acc[person.id].notes.push(booking);
            return acc;
        }, {});
    }, [weeklyBookingsWithNotes, data.personnel]);
    
    const { instrumentsByCat, uncategorizedInstruments } = useMemo(() => {
        return data.instruments.reduce((acc, instrument) => {
            if (instrument.categoryId) {
                if (!acc.instrumentsByCat[instrument.categoryId]) {
                    acc.instrumentsByCat[instrument.categoryId] = [];
                }
                acc.instrumentsByCat[instrument.categoryId].push(instrument);
            } else {
                acc.uncategorizedInstruments.push(instrument);
            }
            return acc;
        }, { instrumentsByCat: {} as Record<string, Instrument[]>, uncategorizedInstruments: [] as Instrument[] });
    }, [data.instruments]);

    const campaignLayout = useMemo(() => {
        const weekStartStr = formatDate(weekDates[0]);
        const weekEndStr = formatDate(weekDates[4]);
        const activeCampaigns = data.campaigns
            .filter(c => c.startDate <= weekEndStr && c.endDate >= weekStartStr)
            .sort((a, b) => {
                if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
                const durationA = new Date(a.endDate).getTime() - new Date(a.startDate).getTime();
                const durationB = new Date(b.endDate).getTime() - new Date(b.endDate).getTime();
                return durationB - durationA;
            });

        const layout: (Campaign | null)[][] = [];

        for (const campaign of activeCampaigns) {
            const campaignStartStr = campaign.startDate;
            const campaignEndStr = campaign.endDate;

            const firstDay = weekDates.findIndex(d => formatDate(d) >= campaignStartStr);
            const lastDayInScope = weekDates.slice().reverse().findIndex(d => formatDate(d) <= campaignEndStr);
            
            const startDayIndex = Math.max(0, firstDay);
            const endDayIndex = lastDayInScope !== -1 ? 4 - lastDayInScope : -1;

            if (endDayIndex < startDayIndex) continue;

            let placed = false;
            for (let rowIndex = 0; rowIndex < layout.length; rowIndex++) {
                const row = layout[rowIndex];
                let canPlace = true;
                for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex++) {
                    if (row[dayIndex]) {
                        canPlace = false;
                        break;
                    }
                }
                if (canPlace) {
                    for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex++) {
                        row[dayIndex] = campaign;
                    }
                    placed = true;
                    break;
                }
            }

            if (!placed) {
                const newRow = Array(5).fill(null);
                for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex++) {
                    newRow[dayIndex] = campaign;
                }
                layout.push(newRow);
            }
        }
        return layout;
    }, [data.campaigns, weekDates]);

    return (
        <div>
            <div className="print-only">
                <div className="print-header">
                    <div className="print-header-title">
                        {data.appLogo && <img src={data.appLogo} alt="App Logo" className="app-logo" />}
                        <h1>Pianificazione Settimanale Strumenti</h1>
                    </div>
                    <div className="week-info">
                        <h2>SETTIMANA {week}</h2>
                        <p>{weekStartDate.toLocaleDateString('it-IT')} - {addDays(weekStartDate, 4).toLocaleDateString('it-IT')}</p>
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="d-flex justify-between align-center">
                    <button className="btn btn-secondary no-print" onClick={() => setCurrentDate(addDays(currentDate, -7))}>&larr; Precedente</button>
                    <div className="text-center">
                        <h2 className="mb-0">SETTIMANA {week}</h2>
                        <p className="text-secondary">{weekStartDate.toLocaleDateString('it-IT')} - {addDays(weekStartDate, 4).toLocaleDateString('it-IT')}</p>
                    </div>
                    <div className="d-flex align-center" style={{gap: '0.75rem'}}>
                        <button className="btn btn-secondary no-print" onClick={() => setCurrentDate(addDays(currentDate, 7))}>Successivo &rarr;</button>
                        {dashboardTab === 'instruments' && (
                             <button className="btn btn-secondary btn-icon no-print" onClick={() => window.print()} title="Stampa settimana">
                                <span className="material-symbols-outlined">print</span>
                            </button>
                        )}
                    </div>
                </div>
                {!isReadOnly && (
                    <div className="template-manager no-print">
                        <div className="template-controls-group">
                             <select className="select-field" value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
                                <option value="">Seleziona un template...</option>
                                {(data.templates || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <button className="btn btn-secondary" onClick={handleApplyTemplate} disabled={!selectedTemplateId}>Applica</button>
                            <button 
                                className="btn btn-danger" 
                                onClick={() => {
                                    const template = data.templates?.find(t => t.id === selectedTemplateId);
                                    if (template) {
                                        setConfirmation({
                                            title: "Conferma Eliminazione Template",
                                            message: (
                                                <>
                                                    <p>Sei sicuro di voler eliminare il template "<strong>{template.name}</strong>"?</p>
                                                    <p className="text-danger">Questa azione non può essere annullata.</p>
                                                </>
                                            ),
                                            onConfirm: () => executeDeleteTemplate(template.id),
                                        });
                                    }
                                }} 
                                disabled={!selectedTemplateId}>
                                Elimina
                            </button>
                        </div>
                        <button className="btn btn-primary btn-icon" onClick={handleSaveTemplate} title="Salva settimana come nuovo template">
                            <span className="material-symbols-outlined">add</span>
                        </button>
                    </div>
                )}
            </div>

            <div className="view-switcher nav-buttons mb-1 no-print">
                <button onClick={() => setDashboardTab('instruments')} className={dashboardTab === 'instruments' ? 'active' : ''}>
                    <span className="material-symbols-outlined">science</span> Vista Strumenti
                </button>
                <button onClick={() => setDashboardTab('personnel')} className={dashboardTab === 'personnel' ? 'active' : ''}>
                    <span className="material-symbols-outlined">groups</span> Vista Personale
                </button>
            </div>

            {dashboardTab === 'instruments' && (
                <>
                    <div className="card instrument-view-controls no-print">
                         <div className="input-group">
                            <label>Filtra per Personale</label>
                            <select className="select-field" value={personnelFilter} onChange={e => setPersonnelFilter(e.target.value)}>
                                <option value="">Mostra Tutti</option>
                                {data.personnel.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="card">
                        <h3>🗓️ PIANIFICAZIONE SETTIMANA</h3>
                        <table className="data-table booking-table">
                            <thead>
                                <tr>
                                    <th className="main-col"></th>
                                    <th className="locale-col"></th>
                                    <th className="sa-col"></th>
                                    {weekDates.map(date => <th key={date.toISOString()} colSpan={2}>{date.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric' })}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {campaignLayout.map((row, rowIndex) => (
                                    <tr key={`campaign-row-${rowIndex}`} className="campaign-row">
                                        <td colSpan={3} className="campaign-header-cell">
                                            {rowIndex === 0 && campaignLayout.length > 0 ? '🧪 CAMPAGNE' : ''}
                                        </td>
                                        {(() => {
                                            const cells: React.ReactNode[] = [];
                                            let i = 0;
                                            while (i < 5) {
                                                const campaign = row[i];
                                                let span = 1;
                                                while (i + span < 5 && row[i + span]?.id === campaign?.id) {
                                                    span++;
                                                }

                                                if (campaign) {
                                                    const category = data.campaignCategories.find(c => c.id === campaign.categoryId);
                                                    cells.push(
                                                        <td 
                                                            key={`${campaign.id}-${i}`}
                                                            colSpan={span * 2}
                                                            className="campaign-day-cell campaign-cell-active"
                                                            style={{ backgroundColor: category?.color || '#cccccc' }}
                                                        >
                                                            <div className="campaign-cell-content">
                                                                <span className="material-symbols-outlined">{category?.icon || 'campaign'}</span>
                                                                {campaign.name}
                                                            </div>
                                                            {span > 1 && (
                                                                <div className="campaign-cell-dividers" aria-hidden="true">
                                                                    {Array.from({ length: span }).map((_, idx) => <div key={idx} />)}
                                                                </div>
                                                            )}
                                                        </td>
                                                    );
                                                } else {
                                                    cells.push(<td key={`empty-${i}`} colSpan={span * 2} className="campaign-day-cell"></td>);
                                                }
                                                i += span;
                                            }
                                            return cells;
                                        })()}
                                    </tr>
                                ))}

                                <tr className="sub-header-row">
                                    <th className="main-col">⚙️ STRUMENTO</th>
                                    <th className="locale-col">LOCALE</th>
                                    <th className="sa-col">SA</th>
                                    {weekDates.map(date => (
                                        <React.Fragment key={date.toISOString()}>
                                            <th className="slot-header">M</th>
                                            <th className="slot-header afternoon">P</th>
                                        </React.Fragment>
                                    ))}
                                </tr>
                                {data.instrumentCategories.map(category => {
                                    const instruments = instrumentsByCat[category.id];
                                    if (!instruments || instruments.length === 0) return null;
                                    return (
                                        <React.Fragment key={category.id}>
                                            <tr className="category-header-row">
                                                <td colSpan={13} title={category.name}>
                                                    <span className="material-symbols-outlined">{category.icon}</span>
                                                </td>
                                            </tr>
                                            {instruments.map(instrument => (
                                                <tr key={instrument.id}>
                                                    <td className="main-col">{instrument.name}</td>
                                                    <td className="locale-col">{instrument.location}</td>
                                                    <td className="sa-col">{instrument.saNumber}</td>
                                                    {weekDates.map(date => {
                                                        const dateStr = formatDate(date);
                                                        return (
                                                            <React.Fragment key={date.toISOString()}>
                                                                <BookingCell date={dateStr} slot="M" instrument={instrument} data={data} setBookingModal={setBookingModal} isReadOnly={isReadOnly} personnelFilter={personnelFilter} />
                                                                <BookingCell date={dateStr} slot="P" instrument={instrument} data={data} setBookingModal={setBookingModal} isReadOnly={isReadOnly} personnelFilter={personnelFilter} />
                                                            </React.Fragment>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    )
                                })}
                                {uncategorizedInstruments.length > 0 && (
                                    <React.Fragment>
                                        <tr className="category-header-row">
                                            <td colSpan={13} title="Senza Categoria">
                                                <span className="material-symbols-outlined">label_off</span>
                                            </td>
                                        </tr>
                                        {uncategorizedInstruments.map(instrument => (
                                            <tr key={instrument.id}>
                                                <td className="main-col">{instrument.name}</td>
                                                <td className="locale-col">{instrument.location}</td>
                                                <td className="sa-col">{instrument.saNumber}</td>
                                                {weekDates.map(date => {
                                                    const dateStr = formatDate(date);
                                                    return (
                                                        <React.Fragment key={date.toISOString()}>
                                                            <BookingCell date={dateStr} slot="M" instrument={instrument} data={data} setBookingModal={setBookingModal} isReadOnly={isReadOnly} personnelFilter={personnelFilter} />
                                                            <BookingCell date={dateStr} slot="P" instrument={instrument} data={data} setBookingModal={setBookingModal} isReadOnly={isReadOnly} personnelFilter={personnelFilter} />
                                                        </React.Fragment>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </React.Fragment>
                                )}
                            </tbody>
                        </table>
                        {Object.keys(notesByPerson).length > 0 && (
                            <div className="booking-notes-section">
                                <h3>NOTE DI PRENOTAZIONE</h3>
                                {Object.values(notesByPerson).map((personData: { name: string; notes: Booking[] }) => (
                                    <div key={personData.name} className="booking-notes-person">
                                        <h4>{personData.name}</h4>
                                        <ul>
                                            {personData.notes.map(booking => {
                                                const instrument = data.instruments.find(i => i.id === booking.instrumentId);
                                                return (
                                                    <li key={booking.id}>
                                                        <span>{new Date(booking.date  + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short' })} ({booking.slot})</span>
                                                        <strong>{instrument?.name}:</strong> {booking.note}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                
                    <div className="card no-print">
                        <h3>🧑‍💼 STATO PERSONALE</h3>
                        <table className="data-table personnel-status-table">
                            <thead>
                                <tr>
                                    <th className="main-col-personnel" rowSpan={2}>PERSONALE</th>
                                    <th className="initials-col" rowSpan={2}>SIGLA</th>
                                    <th className="percentage-col" rowSpan={2}>%</th>
                                    {weekDates.map(date => <th key={date.toISOString()} colSpan={2}>{date.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' })}</th>)}
                                </tr>
                                <tr>
                                    {weekDates.map(date => (
                                        <React.Fragment key={date.toISOString()}>
                                            <th className="slot-header">M</th>
                                            <th className="slot-header afternoon">P</th>
                                        </React.Fragment>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {data.personnel.map(person => (
                                    <tr key={person.id}>
                                        <td className="main-col-personnel">{person.name}</td>
                                        <td className="initials-col text-center">{person.initials}</td>
                                        <td className="percentage-col text-center">{person.workPercentage}</td>
                                        {weekDates.map(date => {
                                            const dateStr = formatDate(date);
                                            return (<React.Fragment key={date.toISOString()}>
                                                <PersonnelStatusCell
                                                    personId={person.id}
                                                    date={date}
                                                    slot="M"
                                                    data={data}
                                                    getAbsenceDetails={getAbsenceDetails}
                                                    isReadOnly={isReadOnly}
                                                    onEdit={(e) => {
                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                        flushSync(() => {
                                                        setEditingStatus({ key: `${person.id}-${dateStr}-M`, top: rect.bottom + window.scrollY, left: rect.left + window.scrollX });
                                                        });
                                                    }}
                                                />
                                                <PersonnelStatusCell
                                                    personId={person.id}
                                                    date={date}
                                                    slot="P"
                                                    data={data}
                                                    getAbsenceDetails={getAbsenceDetails}
                                                    isReadOnly={isReadOnly}
                                                    onEdit={(e) => {
                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                        flushSync(() => {
                                                            setEditingStatus({ key: `${person.id}-${dateStr}-P`, top: rect.bottom + window.scrollY, left: rect.left + window.scrollX });
                                                        });
                                                    }}
                                                />
                                            </React.Fragment>);
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {dashboardTab === 'personnel' && (
                 <PersonnelScheduleView
                    data={data}
                    weekDates={weekDates}
                    getAbsenceDetails={getAbsenceDetails}
                    onAddBooking={setQuickBookingModal}
                    isReadOnly={isReadOnly}
                />
            )}

            <div className="card">
                <h3 className="no-print">NOTE SETTIMANALI</h3>
                <textarea 
                    className="textarea-field no-print"
                    placeholder="Note generali per la settimana..."
                    value={data.weeklyNotes[weekKey] || ''}
                    onChange={(e) => setWeeklyNote(e.target.value)}
                    readOnly={isReadOnly}
                />
                <div className="print-only">
                    <h3>NOTE SETTIMANALI</h3>
                    <p>{data.weeklyNotes[weekKey] || 'Nessuna nota per questa settimana.'}</p>
                </div>
            </div>
            
            <div className="print-only card">
                <h3>Legenda Personale</h3>
                <div className="print-legend-items">
                    {data.personnel.map(p => (
                        <div key={p.id} className="legend-item">
                            <span className="color-dot" style={{ backgroundColor: p.color }}></span>
                            {p.name}
                        </div>
                    ))}
                </div>
            </div>

            {editingStatus && !isReadOnly && (
                <StatusPicker
                    onClose={() => setEditingStatus(null)}
                    onSelect={(typeId) => handleStatusChange(editingStatus.key, typeId)}
                    absenceTypes={data.absenceTypes.filter(at => at.id !== 'fisse')}
                    position={editingStatus}
                />
            )}
            
            {bookingModal && !isReadOnly &&
                <BookingModal
                    isOpen={!!bookingModal}
                    onClose={() => setBookingModal(null)}
                    onSave={handleSaveBooking}
                    onDelete={handleDeleteBooking}
                    instrument={data.instruments.find(i => i.id === bookingModal.instrumentId)!}
                    personnelList={data.personnel}
                    date={bookingModal.date}
                    slot={bookingModal.slot}
                    isPersonAbsent={(personnelId, date, slot) => !!getAbsenceDetails(personnelId, new Date(date + 'T00:00:00'), slot)}
                    existingBooking={data.bookings.find(b => b.instrumentId === bookingModal.instrumentId && b.date === bookingModal.date && b.slot === bookingModal.slot)}
                />
            }

            {quickBookingModal && !isReadOnly &&
                <QuickAddBookingModal
                    isOpen={!!quickBookingModal}
                    onClose={() => setQuickBookingModal(null)}
                    onSave={handleSaveBooking}
                    personnel={data.personnel.find(p => p.id === quickBookingModal.personnelId)!}
                    instrumentList={data.instruments}
                    date={quickBookingModal.date}
                    slot={quickBookingModal.slot}
                    isPersonAbsent={(personnelId, date, slot) => !!getAbsenceDetails(personnelId, new Date(date + 'T00:00:00'), slot)}
                />
            }
            <AlertModal
                isOpen={!!alertMessage}
                onClose={() => setAlertMessage('')}
                title="Informazione"
            >
                <p>{alertMessage}</p>
            </AlertModal>

            <PromptModal
                isOpen={isNamingTemplate}
                onClose={() => setIsNamingTemplate(false)}
                onConfirm={executeSaveTemplate}
                title="Salva Nuovo Template"
                message="Inserisci un nome per il nuovo template."
            />
            
            <ConfirmationModal
                isOpen={!!confirmation}
                onClose={() => setConfirmation(null)}
                onConfirm={() => {
                    confirmation?.onConfirm();
                    setConfirmation(null);
                }}
                title={confirmation?.title || 'Conferma'}
            >
                {confirmation?.message}
            </ConfirmationModal>
        </div>
    );
};

const PersonnelStatusCell: React.FC<{
    personId: string,
    date: Date,
    slot: 'M' | 'P',
    data: AppData,
    getAbsenceDetails: (personnelId: string, date: Date, slot: 'M' | 'P') => AbsenceType | null,
    onEdit: (event: React.MouseEvent<HTMLTableCellElement>) => void,
    isReadOnly: boolean;
}> = ({ personId, date, slot, data, getAbsenceDetails, onEdit, isReadOnly }) => {
    const dateStr = formatDate(date);
    const key = `${personId}-${dateStr}-${slot}`;
    const overrideTypeId = data.statusOverrides[key];

    let absenceDetails: AbsenceType | null = null;
    let isPresent = false;

    if (overrideTypeId) {
        if (overrideTypeId === 'present') {
            isPresent = true;
        } else {
            absenceDetails = data.absenceTypes.find(at => at.id === overrideTypeId) || null;
        }
    } else {
        absenceDetails = getAbsenceDetails(personId, date, slot);
    }
    
    const style = absenceDetails ? { backgroundColor: absenceDetails.color } : {};
    const isClickable = !isReadOnly;

    return (
         <td
            className={`status-cell ${slot === 'P' ? 'afternoon' : ''} ${isClickable ? 'clickable' : ''}`}
            style={style}
            onClick={isClickable ? onEdit : undefined}
        >
            {absenceDetails ? absenceDetails.name : <span className={`status-present ${isPresent ? 'override' : ''}`}></span>}
        </td>
    );
};


const BookingCell: React.FC<{
    date: string;
    slot: 'M' | 'P';
    instrument: Instrument;
    data: AppData;
    setBookingModal: (modalInfo: { instrumentId: string; date: string; slot: 'M' | 'P' }) => void;
    isReadOnly: boolean;
    personnelFilter: string;
}> = ({ date, slot, instrument, data, setBookingModal, isReadOnly, personnelFilter }) => {
    const booking = data.bookings.find(b => b.instrumentId === instrument.id && b.date === date && b.slot === slot);
    
    if (personnelFilter && booking?.personnelId !== personnelFilter) {
        return <td className={`booking-cell ${slot === 'P' ? 'afternoon' : ''} filtered-out`}></td>;
    }

    const person = booking ? data.personnel.find(p => p.id === booking.personnelId) : null;
    const style = person ? { backgroundColor: person.color } : {};
    const isClickable = !isReadOnly;

    return (
        <td
            style={style}
            className={`booking-cell ${slot === 'P' ? 'afternoon' : ''} ${person ? 'booked' : ''} ${isClickable ? 'clickable' : ''}`}
            onClick={isClickable ? () => setBookingModal({ instrumentId: instrument.id, date, slot }) : undefined}
        >
            {person?.name}
            {booking?.note && (
                <svg className="note-indicator" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                    <title>{booking.note}</title>
                    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"></path>
                </svg>
            )}
        </td>
    );
};

// --- DATA MANAGEMENT VIEW ---
interface DataManagementViewProps {
    data: AppData;
    onDataChange: <K extends keyof AppData>(key: K, value: AppData[K]) => void;
    setFullData: React.Dispatch<React.SetStateAction<AppData>>;
}

const FixedAbsenceEditor: React.FC<{ value: Personnel['fixedAbsences'], onChange: (newValue: Personnel['fixedAbsences']) => void, absenceTypes: AbsenceType[] }> = ({ value, onChange, absenceTypes }) => {
    const days = [{label: 'LUN', value: 0}, {label: 'MAR', value: 1}, {label: 'MER', value: 2}, {label: 'GIO', value: 3}, {label: 'VEN', value: 4}];
    const slots: ('M' | 'P')[] = ['M', 'P'];

    const handleChange = (dayIndex: number, slot: 'M' | 'P', typeId: string) => {
        const newAbsences = JSON.parse(JSON.stringify(value || {}));
        
        if (!typeId) {
            if (newAbsences[dayIndex]) {
                delete newAbsences[dayIndex][slot];
                if (Object.keys(newAbsences[dayIndex]).length === 0) {
                    delete newAbsences[dayIndex];
                }
            }
        } else {
            if (!newAbsences[dayIndex]) {
                newAbsences[dayIndex] = {};
            }
            newAbsences[dayIndex][slot] = typeId;
        }
        onChange(newAbsences);
    };

    return (
        <table className="fixed-absence-editor">
            <thead>
                <tr>
                    <th>Giorno</th>
                    <th>Mattina</th>
                    <th>Pomeriggio</th>
                </tr>
            </thead>
            <tbody>
                {days.map(day => (
                    <tr key={day.value}>
                        <td>{day.label}</td>
                        {slots.map(slot => (
                            <td key={slot}>
                                <select 
                                    className="select-field"
                                    value={value?.[day.value]?.[slot] || ''}
                                    onChange={e => handleChange(day.value, slot, e.target.value)}
                                >
                                    <option value="">Presente</option>
                                    {absenceTypes.map(at => <option key={at.id} value={at.id}>{at.name}</option>)}
                                </select>
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
};


const DataManagementView: React.FC<DataManagementViewProps> = ({ data, onDataChange, setFullData }) => {
    const [tab, setTab] = useState<DataManagementTab>(() => loadPrefs().dataManagementTab || 'instruments');
    
    useEffect(() => {
        savePref('dataManagementTab', tab);
    }, [tab]);
    
    const CrudComponent = <T extends { id: string } & Record<string, any>>({ name, items, setItems, fields, data, onImportICS }: {
        name: string;
        items: T[];
        setItems: (items: T[]) => void;
        fields: { key: keyof T, label: string, type: string, options?: any, props?: any }[];
        data?: AppData;
        onImportICS?: (fileContent: string) => void;
    }) => {
        const [editing, setEditing] = useState<Partial<T> | null>(null);
        const [itemToDelete, setItemToDelete] = useState<T | null>(null);
        const importRef = useRef<HTMLInputElement>(null);
        
        const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file && onImportICS) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    onImportICS(event.target?.result as string);
                };
                reader.readAsText(file);
            }
            // Reset input to allow importing the same file again
            if (e.target) e.target.value = '';
        };

        const handleSave = () => {
            if (!editing || !editing.name) {
                alert('Il nome è obbligatorio.');
                return;
            }

            const itemToSave = { ...editing };

            if (itemToSave.id) {
                setItems(items.map(i => i.id === itemToSave.id ? itemToSave as T : i));
            } else {
                setItems([...items, { ...itemToSave, id: Date.now().toString() } as T]);
            }
            setEditing(null);
        };

        const handleConfirmDelete = () => {
            if (itemToDelete) {
                setItems(items.filter(i => i.id !== itemToDelete.id));
                setItemToDelete(null);
            }
        };
        
        const renderField = (item: Partial<T>, field: typeof fields[0]) => {
             const value = item[field.key] as any;
             if (field.type === 'fixed-absence-editor' && data) {
                 return <FixedAbsenceEditor 
                    value={value || {}} 
                    onChange={val => setEditing(prev => ({ ...prev, [field.key]: val }))}
                    absenceTypes={data.absenceTypes}
                />;
             }
             if (field.type === 'color-palette') {
                 return <ColorPicker value={value} onChange={val => setEditing(prev => ({...prev, [field.key]: val}))} />
             }
              if (field.type === 'icon-picker') {
                return <IconPickerTrigger value={value} onChange={val => setEditing(prev => ({...prev, [field.key]: val}))} />
            }
             if (field.type === 'select') {
                 return <select className="select-field" value={value || ''} onChange={e => setEditing(prev => ({ ...prev, [field.key]: e.target.value }))}>
                     {field.options.map((opt: {label: string, value: any}) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                 </select>
             }
             if (field.type === 'textarea') {
                 return (
                     <textarea
                         className="textarea-field"
                         value={value || ''}
                         onChange={e => setEditing(prev => ({ ...prev, [field.key]: e.target.value }))}
                         {...field.props}
                     />
                 )
             }
             return (
                 <input
                     type={field.type}
                     className="input-field"
                     value={value || ''}
                     onChange={e => setEditing(prev => ({ ...prev, [field.key]: e.target.value }))}
                     {...field.props}
                 />
             )
        }

        return (
            <div className="card">
                <div className="d-flex justify-between align-center">
                    <h3>{name}</h3>
                    <div className="card-header-actions">
                        {onImportICS && <>
                            <button className="btn btn-secondary" onClick={() => importRef.current?.click()}>Importa ICS</button>
                            <input type="file" ref={importRef} style={{display: 'none'}} accept=".ics" onChange={handleFileSelected} />
                        </>}
                        <button className="btn btn-primary" onClick={() => setEditing({})}>Aggiungi</button>
                    </div>
                </div>
                {editing && (
                    <div className="card mt-1">
                        <h4>{editing.id ? 'Modifica' : 'Aggiungi'} {name}</h4>
                        {fields.map(field => (
                            <div className="input-group" key={field.key as string}>
                                <label>{field.label}</label>
                                {renderField(editing, field)}
                            </div>
                        ))}
                        <div className="modal-footer" style={{padding:0, justifyContent: 'flex-end'}}><div>
                            <button className="btn btn-secondary" onClick={() => setEditing(null)}>Annulla</button>
                            <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                        </div></div>
                    </div>
                )}
                <table className="data-table">
                    <tbody>
                        {items.map(item => (
                            <tr key={item.id}>
                                <td>
                                    {item.icon && <span className="material-symbols-outlined">{item.icon}</span>}
                                    {item.name}
                                </td>
                                <td style={{textAlign: 'right'}}>
                                    <button className="btn btn-secondary" onClick={() => setEditing(item)}>Modifica</button>
                                    <button className="btn btn-danger" style={{marginLeft: '0.5rem'}} onClick={() => setItemToDelete(item)}>Elimina</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <ConfirmationModal
                    isOpen={!!itemToDelete}
                    onClose={() => setItemToDelete(null)}
                    onConfirm={handleConfirmDelete}
                    title={`Conferma Eliminazione`}
                >
                    <p>Sei sicuro di voler eliminare "<strong>{itemToDelete?.name}</strong>"?</p>
                    <p className="text-danger">Questa azione non può essere annullata.</p>
                </ConfirmationModal>
            </div>
        );
    };

    return (
        <div>
            <div className="nav-buttons mb-1">
                <button onClick={() => setTab('instruments')} className={tab === 'instruments' ? 'active' : ''}>Strumenti</button>
                <button onClick={() => setTab('instrumentCategories')} className={tab === 'instrumentCategories' ? 'active' : ''}>Cat. Strumenti</button>
                <button onClick={() => setTab('personnel')} className={tab === 'personnel' ? 'active' : ''}>Personale</button>
                <button onClick={() => setTab('absences')} className={tab === 'absences' ? 'active' : ''}>Assenze</button>
                <button onClick={() => setTab('absenceTypes')} className={tab === 'absenceTypes' ? 'active' : ''}>Tipi Assenza</button>
                <button onClick={() => setTab('campaigns')} className={tab === 'campaigns' ? 'active' : ''}>Campagne</button>
                <button onClick={() => setTab('campaignCategories')} className={tab === 'campaignCategories' ? 'active' : ''}>Cat. Campagne</button>
                <button onClick={() => setTab('backup')} className={tab === 'backup' ? 'active' : ''}>Gestione Dati</button>
            </div>
            
            {tab === 'instruments' && <CrudComponent name="Strumento" items={data.instruments} setItems={(items) => onDataChange('instruments', items)} fields={[
                 { key: 'name', label: 'Nome', type: 'text' },
                 { key: 'categoryId', label: 'Categoria', type: 'select', options: [{label: 'Seleziona...', value: ''}, ...data.instrumentCategories.map(c => ({label: c.name, value: c.id}))] },
                 { key: 'location', label: 'Locale', type: 'text' },
                 { key: 'saNumber', label: 'Numero SA', type: 'text' },
                 { key: 'weight', label: 'Peso/Complessità (1-5)', type: 'number', props: { min: 1, max: 5, step: 1 } },
            ]} />}

            {tab === 'instrumentCategories' && <CrudComponent name="Categoria Strumento" items={data.instrumentCategories} setItems={(items) => onDataChange('instrumentCategories', items)} fields={[
                 { key: 'name', label: 'Nome', type: 'text' },
                 { key: 'icon', label: 'Icona', type: 'icon-picker' },
            ]} />}
            
            {tab === 'personnel' && <CrudComponent data={data} name="Personale" items={data.personnel} setItems={(items) => onDataChange('personnel', items)} fields={[
                { key: 'name', label: 'Nome Completo', type: 'text' },
                { key: 'initials', label: 'Sigla', type: 'text' },
                { key: 'workPercentage', label: '% Lavorativa', type: 'number', props: {min: 0, max: 100} },
                { key: 'color', label: 'Colore Associato', type: 'color-palette' },
                { key: 'keywords', label: 'Parole Chiave Assegnazione (separate da virgola)', type: 'textarea' },
                { key: 'fixedAbsences', label: 'Assenze Fisse Settimanali', type: 'fixed-absence-editor' }
            ]} />}

            {tab === 'absences' && <AbsenceManager data={data} onDataChange={onDataChange} setFullData={setFullData} />}

            {tab === 'absenceTypes' && <CrudComponent name="Tipo Assenza" items={data.absenceTypes} setItems={(items) => onDataChange('absenceTypes', items)} fields={[
                { key: 'name', label: 'Nome', type: 'text' },
                { key: 'color', label: 'Colore', type: 'color-palette' },
            ]} />}
            
            {tab === 'campaigns' && <CampaignManager data={data} onDataChange={onDataChange} setFullData={setFullData} />}

             {tab === 'campaignCategories' && <CrudComponent name="Categoria Campagna" items={data.campaignCategories} setItems={(items) => onDataChange('campaignCategories', items)} fields={[
                 { key: 'name', label: 'Nome', type: 'text' },
                 { key: 'icon', label: 'Icona', type: 'icon-picker' },
                 { key: 'color', label: 'Colore', type: 'color-palette' },
                 { key: 'keywords', label: 'Parole Chiave (separate da virgola)', type: 'textarea' },
            ]} />}

            {tab === 'backup' && <DataBackupManager data={data} onImport={setFullData} />}
        </div>
    );
};

// --- DATA BACKUP MANAGER ---
const DataBackupManager: React.FC<{ data: AppData; onImport: (data: AppData) => void; }> = ({ data, onImport }) => {
    const importInputRef = useRef<HTMLInputElement>(null);

    const handleExport = () => {
        try {
            const jsonData = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonData], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const today = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `lab-planner-backup-${today}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Errore durante l'esportazione dei dati:", error);
            alert("Si è verificato un errore durante l'esportazione dei dati.");
        }
    };

    const handleImportClick = () => {
        importInputRef.current?.click();
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!confirm("Sei sicuro di voler importare i dati? Questa operazione sostituirà tutti i dati correnti e non può essere annullata.")) {
            if (event.target) event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result;
                if (typeof text !== 'string') throw new Error("File non valido.");
                const parsedData = JSON.parse(text);

                // Basic validation
                if (!parsedData.instruments || !parsedData.personnel || !parsedData.bookings) {
                     throw new Error("Il file non sembra essere un backup valido del Lab Planner.");
                }

                onImport(parsedData);
                alert("Dati importati con successo!");

            } catch (error: any) {
                console.error("Errore durante l'importazione dei dati:", error);
                alert(`Errore: ${error.message || "Impossibile leggere o analizzare il file di backup."}`);
            } finally {
                 if (event.target) event.target.value = '';
            }
        };
        reader.onerror = () => {
            alert("Errore durante la lettura del file.");
            if (event.target) event.target.value = '';
        };
        reader.readAsText(file);
    };


    return (
        <div className="card">
            <h3>Gestione Dati e Backup</h3>
            <p className="text-secondary">Esporta i dati per creare un backup o importali per ripristinare uno stato precedente.</p>
            <div className="backup-actions-grid">
                <div className="backup-action-card">
                    <h4>Esporta Dati</h4>
                    <p>Salva una copia di tutti i dati correnti (strumenti, personale, prenotazioni, ecc.) in un file sul tuo computer.</p>
                    <button onClick={handleExport} className="btn btn-primary">
                        <span className="material-symbols-outlined">download</span> Esporta Backup
                    </button>
                </div>
                <div className="backup-action-card">
                    <h4>Importa Dati</h4>
                    <p>Carica i dati da un file di backup. <strong className="text-danger">Attenzione:</strong> Questa operazione sostituirà tutti i dati attuali.</p>
                     <button onClick={handleImportClick} className="btn btn-danger">
                         <span className="material-symbols-outlined">upload</span> Importa da Backup
                    </button>
                    <input
                        type="file"
                        ref={importInputRef}
                        onChange={handleFileChange}
                        accept=".json"
                        style={{ display: 'none' }}
                    />
                </div>
            </div>
        </div>
    );
}

// --- CAMPAIGN CALENDAR VIEW ---
const CampaignCalendarView: React.FC<{
    data: AppData;
    onEdit: (campaign: Campaign) => void;
    onAdd: (date: Date) => void;
}> = ({ data, onEdit, onAdd }) => {
    const [currentDate, setCurrentDate] = useState(new Date());

    const changeMonth = (direction: number) => {
        setCurrentDate(prev => {
            const newDate = new Date(prev);
            newDate.setMonth(newDate.getMonth() + direction);
            return newDate;
        });
    };

    const { monthDays, monthStart, monthEnd } = useMemo(() => {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDayOfMonth = new Date(year, month, 1);
        const lastDayOfMonth = new Date(year, month + 1, 0);
        
        const days = [];
        // Day of week: 0=Sun, 1=Mon, ..., 6=Sat. We want 0=Mon.
        const startDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7; 
        
        // Add padding for days from previous month
        for (let i = 0; i < startDayOfWeek; i++) {
            days.push(null);
        }
        
        // Add days of current month
        for (let i = 1; i <= lastDayOfMonth.getDate(); i++) {
            days.push(new Date(year, month, i));
        }

        return { monthDays: days, monthStart: firstDayOfMonth, monthEnd: lastDayOfMonth };
    }, [currentDate]);

    const campaignsInMonth = useMemo(() => {
        const startStr = formatDate(monthStart);
        const endStr = formatDate(monthEnd);
        return data.campaigns.filter(c => c.startDate <= endStr && c.endDate >= startStr);
    }, [data.campaigns, monthStart, monthEnd]);

    const todayStr = formatDate(new Date());

    return (
        <div className="campaign-calendar-container">
            <div className="calendar-header d-flex justify-between align-center">
                <button className="btn btn-secondary" onClick={() => changeMonth(-1)}>&larr;</button>
                <h2>{currentDate.toLocaleString('it-IT', { month: 'long', year: 'numeric' })}</h2>
                <button className="btn btn-secondary" onClick={() => changeMonth(1)}>&rarr;</button>
            </div>
            <div className="campaign-calendar-grid">
                {['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((day, index) => <div key={index} className="calendar-day-header">{day}</div>)}
                {monthDays.map((day, index) => {
                    const dayStr = day ? formatDate(day) : '';
                    const campaignsOnThisDay = day ? campaignsInMonth.filter(c => c.startDate <= dayStr && c.endDate >= dayStr) : [];
                    
                    const isToday = dayStr === todayStr;

                    return (
                        <div 
                            key={index} 
                            className={`calendar-day ${!day ? 'other-month' : ''} ${isToday ? 'today' : ''}`}
                            onDoubleClick={day ? () => onAdd(day) : undefined}
                        >
                            <div className="day-number">{day?.getDate()}</div>
                            <div className="campaign-items">
                                {campaignsOnThisDay.map(campaign => {
                                    const category = data.campaignCategories.find(c => c.id === campaign.categoryId);
                                    return (
                                        <div 
                                            key={campaign.id} 
                                            className="calendar-campaign-item"
                                            style={{ backgroundColor: category?.color || '#ccc' }}
                                            title={campaign.name}
                                            onClick={(e) => {
                                                e.stopPropagation(); // Prevent double click from firing on the parent
                                                onEdit(campaign);
                                            }}
                                        >
                                            {campaign.name}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};


// --- CAMPAIGN MANAGER ---
const CampaignManager: React.FC<DataManagementViewProps> = ({ data, onDataChange }) => {
    const [editing, setEditing] = useState<Partial<Campaign> | null>(null);
    const [campaignToDelete, setCampaignToDelete] = useState<Campaign | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
    const importRef = useRef<HTMLInputElement>(null);
    const uncategorizedCampaigns = useMemo(() => data.campaigns.filter(c => !c.categoryId || !c.managerId), [data.campaigns]);

    const handleSave = () => {
        if (!editing) return;
        const itemToSave = { ...editing };
        if (itemToSave.id) {
            onDataChange('campaigns', data.campaigns.map(i => i.id === itemToSave.id ? itemToSave as Campaign : i));
        } else {
            onDataChange('campaigns', [...data.campaigns, { ...itemToSave, id: Date.now().toString() } as Campaign]);
        }
        setEditing(null);
    };
    
    const handleConfirmDelete = () => {
        if (campaignToDelete) {
            onDataChange('campaigns', data.campaigns.filter(c => c.id !== campaignToDelete.id));
            setCampaignToDelete(null);
        }
    };
    
    const handleEndDateChange = (endDate: string) => {
        const newDeliveryDate = addWorkingDays(endDate, 10);
        setEditing(p => ({ ...p, endDate, deliveryDate: p?.deliveryDate || newDeliveryDate }));
    };

    const handleAddCampaignFromCalendar = (date: Date) => {
        const dateStr = formatDate(date);
        setEditing({
            name: '',
            startDate: dateStr,
            endDate: dateStr,
            categoryId: '',
            managerId: '',
            deliveryDate: addWorkingDays(dateStr, 10),
        });
    };

    const handleReprocessCampaigns = () => {
        let changedCount = 0;
        const updatedCampaigns = data.campaigns.map(campaign => {
            let updatedCampaign = { ...campaign };
            let hasChanged = false;
            
            if (!updatedCampaign.categoryId) {
                const foundCategory = findByKeywords(updatedCampaign.name, data.campaignCategories);
                if (foundCategory) {
                    updatedCampaign.categoryId = foundCategory.id;
                    hasChanged = true;
                }
            }
            if (!updatedCampaign.managerId) {
                const foundManager = findByKeywords(updatedCampaign.name, data.personnel);
                if (foundManager) {
                    updatedCampaign.managerId = foundManager.id;
                    hasChanged = true;
                }
            }

            if(hasChanged) changedCount++;
            return updatedCampaign;
        });

        if (changedCount > 0) {
            onDataChange('campaigns', updatedCampaigns);
            alert(`${changedCount} campagne sono state aggiornate con successo.`);
        } else {
            alert("Nessuna nuova corrispondenza trovata. Controlla le parole chiave.");
        }
    };
    
    const handleCampaignsImport = (fileContent: string) => {
        try {
            const events = parseICS(fileContent);
            let categorizedCount = 0;
            let managedCount = 0;

            const newCampaigns: Campaign[] = events.map(event => {
                const category = findByKeywords(event.summary, data.campaignCategories);
                const manager = findByKeywords(event.summary, data.personnel);

                if(category) categorizedCount++;
                if(manager) managedCount++;

                const deliveryDate = addWorkingDays(event.endDate, 10);
                return {
                    id: `${Date.now()}-${Math.random()}`,
                    name: event.summary,
                    startDate: event.startDate,
                    endDate: event.endDate,
                    categoryId: category?.id || '',
                    managerId: manager?.id || '',
                    deliveryDate: deliveryDate,
                }
            });

            if(newCampaigns.length > 0) {
                 onDataChange('campaigns', [...data.campaigns, ...newCampaigns]);
                 alert(`${newCampaigns.length} campagne importate. ${categorizedCount} categorizzate, ${managedCount} con responsabile assegnato.`);
            } else {
                 alert("Nessun evento valido trovato nel file ICS.");
            }
        } catch (error) {
            alert("Errore durante l'importazione del file ICS.");
            console.error(error);
        }
    };
    
    const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                handleCampaignsImport(event.target?.result as string);
            };
            reader.readAsText(file);
        }
        if (e.target) e.target.value = '';
    };

    return (
        <div className="card">
            <div className="campaign-manager-header d-flex justify-between align-center">
                <div className="d-flex align-center gap-1">
                    <h3>Campagne</h3>
                    <div className="nav-buttons view-switcher">
                        <button onClick={() => setViewMode('list')} className={viewMode === 'list' ? 'active' : ''}><span className="material-symbols-outlined">view_list</span>Lista</button>
                        <button onClick={() => setViewMode('calendar')} className={viewMode === 'calendar' ? 'active' : ''}><span className="material-symbols-outlined">calendar_month</span>Calendario</button>
                    </div>
                </div>
                <div className="card-header-actions">
                    <button className="btn btn-secondary" onClick={() => importRef.current?.click()}>Importa ICS</button>
                    <input type="file" ref={importRef} style={{display: 'none'}} accept=".ics" onChange={handleFileSelected} />
                    <button className="btn btn-primary" onClick={() => setEditing({})}>Aggiungi Campagna</button>
                </div>
            </div>
            
            {uncategorizedCampaigns.length > 0 && viewMode === 'list' && (
                <div className="reprocess-section">
                    <p>Ci sono {uncategorizedCampaigns.length} campagne senza categoria o responsabile.</p>
                    <button className="btn btn-primary" onClick={handleReprocessCampaigns}>Tenta Assegnazione Automatica</button>
                </div>
            )}

            {editing && (
                 <div className="card mt-1">
                    <h4>{editing.id ? 'Modifica' : 'Aggiungi'} Campagna</h4>
                     <div className="input-group">
                        <label>Nome</label>
                        <input type="text" className="input-field" value={editing.name || ''} onChange={e => setEditing(p => ({...p, name: e.target.value}))} />
                    </div>
                     <div className="input-group">
                        <label>Categoria</label>
                        <select className="select-field" value={editing.categoryId || ''} onChange={e => setEditing(p => ({...p, categoryId: e.target.value}))}>
                            <option value="">Seleziona...</option>
                            {data.campaignCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </div>
                     <div className="input-group">
                        <label>Responsabile Campagna</label>
                        <select className="select-field" value={editing.managerId || ''} onChange={e => setEditing(p => ({...p, managerId: e.target.value}))}>
                            <option value="">Seleziona...</option>
                            {data.personnel.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </div>
                     <div className="input-group">
                        <label>Data Inizio</label>
                        <input type="date" className="input-field" value={editing.startDate || ''} onChange={e => setEditing(p => ({...p, startDate: e.target.value}))} />
                    </div>
                     <div className="input-group">
                        <label>Data Fine</label>
                        <input type="date" className="input-field" value={editing.endDate || ''} onChange={e => handleEndDateChange(e.target.value)} />
                    </div>
                    <div className="input-group">
                        <label>Termine Consegna</label>
                        <input type="date" className="input-field" value={editing.deliveryDate || ''} onChange={e => setEditing(p => ({...p, deliveryDate: e.target.value}))} />
                    </div>
                    <div className="modal-footer" style={{padding:0, justifyContent: 'flex-end'}}><div>
                        <button className="btn btn-secondary" onClick={() => setEditing(null)}>Annulla</button>
                        <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                    </div></div>
                </div>
            )}
            
            {viewMode === 'list' && (
                <table className="data-table">
                    <thead><tr><th>Nome</th><th>Categoria</th><th>Da</th><th>A</th><th></th></tr></thead>
                    <tbody>
                        {data.campaigns.map(campaign => (
                            <tr key={campaign.id}>
                                <td>{campaign.name}</td>
                                <td style={{backgroundColor: data.campaignCategories.find(c=> c.id === campaign.categoryId)?.color + '20' }}>
                                    {data.campaignCategories.find(c => c.id === campaign.categoryId)?.name || 'N/A'}
                                </td>
                                <td>{new Date(campaign.startDate  + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                                <td>{new Date(campaign.endDate  + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                                <td style={{textAlign: 'right'}}>
                                    <button className="btn btn-secondary" onClick={() => setEditing(campaign)}>Modifica</button>
                                    <button className="btn btn-danger" style={{marginLeft: '0.5rem'}} onClick={() => setCampaignToDelete(campaign)}>Elimina</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {viewMode === 'calendar' && (
                <CampaignCalendarView data={data} onEdit={setEditing} onAdd={handleAddCampaignFromCalendar} />
            )}

            <ConfirmationModal
                isOpen={!!campaignToDelete}
                onClose={() => setCampaignToDelete(null)}
                onConfirm={handleConfirmDelete}
                title="Conferma Eliminazione"
            >
                <p>Sei sicuro di voler eliminare la campagna "<strong>{campaignToDelete?.name}</strong>"?</p>
                <p className="text-danger">Questa azione non può essere annullata.</p>
            </ConfirmationModal>
        </div>
    );
};

// --- ABSENCE MANAGER ---
const AbsenceManager: React.FC<DataManagementViewProps> = ({ data, onDataChange }) => {
    const [editing, setEditing] = useState<Partial<Absence> | null>(null);
    const [absenceToDelete, setAbsenceToDelete] = useState<Absence | null>(null);
    const [unprocessedToDelete, setUnprocessedToDelete] = useState<UnprocessedAbsence | null>(null);
    const importRef = useRef<HTMLInputElement>(null);
    const unprocessedAbsences = data.unprocessedAbsences || [];

    const handleSave = () => {
        if (!editing || !editing.personnelId || !editing.typeId || !editing.startDate || !editing.endDate) {
            alert("Compilare tutti i campi obbligatori.");
            return;
        }
        if (editing.id) {
            onDataChange('absences', data.absences.map(a => a.id === editing.id ? editing as Absence : a));
        } else {
            onDataChange('absences', [...data.absences, { ...editing, id: Date.now().toString() } as Absence]);
        }
        setEditing(null);
    };

    const handleConfirmAbsenceDelete = () => {
        if (absenceToDelete) {
            onDataChange('absences', data.absences.filter(a => a.id !== absenceToDelete.id));
            setAbsenceToDelete(null);
        }
    };
    
    const handleConfirmUnprocessedDelete = () => {
        if (unprocessedToDelete) {
            onDataChange('unprocessedAbsences', (data.unprocessedAbsences || []).filter(u => u.id !== unprocessedToDelete.id));
            setUnprocessedToDelete(null);
        }
    };

    const findPersonnelFromSummary = (summary: string, personnelList: Personnel[]): Personnel | null => {
        // 1. Strict match first: [SIGLA]
        const initialsMatch = summary.match(/^\[(.*?)\]/);
        if (initialsMatch && initialsMatch[1]) {
            const initials = initialsMatch[1].toUpperCase();
            const person = personnelList.find(p => p.initials.toUpperCase() === initials);
            if (person) return person;
        }

        // 2. Flexible match: Look for initials as a whole word, case-insensitive
        for (const person of personnelList) {
            if (person.initials) {
                const regex = new RegExp(`\\b${person.initials}\\b`, 'i');
                if (regex.test(summary)) {
                    return person;
                }
            }
        }
        
        return null;
    };

    const handleAbsenceImport = (fileContent: string) => {
        try {
            const events = parseICS(fileContent);
            const newAbsences: Absence[] = [];
            const unprocessed: UnprocessedAbsence[] = [];
            const ferieType = data.absenceTypes.find(at => at.id === 'ferie');

            if (!ferieType) {
                alert("Tipo di assenza 'Ferie' non trovato. Impossibile importare.");
                return;
            }

            for (const event of events) {
                const person = findPersonnelFromSummary(event.summary, data.personnel);
                
                if (person) {
                    newAbsences.push({
                        id: `${Date.now()}-${Math.random()}`,
                        personnelId: person.id,
                        startDate: event.startDate,
                        endDate: event.endDate,
                        typeId: ferieType.id, // default to Ferie
                        note: event.summary,
                    });
                } else {
                     unprocessed.push({
                         id: `${Date.now()}-${Math.random()}`,
                         summary: event.summary,
                         startDate: event.startDate,
                         endDate: event.endDate,
                         failureReason: `Nessuna sigla trovata nel testo.`
                     });
                }
            }

            let message = '';
            if (newAbsences.length > 0) {
                onDataChange('absences', [...data.absences, ...newAbsences]);
                message += `${newAbsences.length} assenze importate con successo.\n`;
            }
            if (unprocessed.length > 0) {
                onDataChange('unprocessedAbsences', [...(data.unprocessedAbsences || []), ...unprocessed]);
                message += `${unprocessed.length} assenze non importate. Controlla la sezione "Importazioni Fallite".`;
            }
            if (!message) {
                message = "Nessun evento valido trovato nel file ICS.";
            }
            alert(message);

        } catch (error) {
            alert("Errore durante l'importazione del file ICS.");
            console.error(error);
        }
    };
    
    const handleReprocess = () => {
        if (unprocessedAbsences.length === 0) return;
    
        const ferieType = data.absenceTypes.find(at => at.id === 'ferie');
        const newlyProcessed: Absence[] = [];
        const stillUnprocessed: UnprocessedAbsence[] = [];
        let processedCount = 0;
    
        for (const item of unprocessedAbsences) {
            const person = findPersonnelFromSummary(item.summary, data.personnel);
            let found = false;

            if (person && ferieType) {
                newlyProcessed.push({
                    id: `${Date.now()}-${Math.random()}`,
                    personnelId: person.id,
                    startDate: item.startDate,
                    endDate: item.endDate,
                    typeId: ferieType.id,
                    note: item.summary,
                });
                processedCount++;
                found = true;
            }

            if (!found) {
                item.failureReason = `Sigla non trovata nel testo.`;
                stillUnprocessed.push(item);
            }
        }
    
        if (processedCount > 0) {
            onDataChange('absences', [...data.absences, ...newlyProcessed]);
            onDataChange('unprocessedAbsences', stillUnprocessed);
            alert(`${processedCount} assenze sono state importate con successo.`);
        } else {
            alert("Nessuna nuova corrispondenza trovata. Assicurati che le sigle nell'anagrafica del personale siano corrette.");
        }
    };
    
    const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                handleAbsenceImport(event.target?.result as string);
            };
            reader.readAsText(file);
        }
        if (e.target) e.target.value = '';
    };

    const personForAbsence = useMemo(() => {
        if (!absenceToDelete) return null;
        return data.personnel.find(p => p.id === absenceToDelete.personnelId);
    }, [absenceToDelete, data.personnel]);


    return (
        <div className="card">
            <div className="d-flex justify-between align-center">
                <h3>Assenze</h3>
                <div className="card-header-actions">
                    <button className="btn btn-secondary" onClick={() => importRef.current?.click()}>Importa ICS</button>
                    <input type="file" ref={importRef} style={{display: 'none'}} accept=".ics" onChange={handleFileSelected} />
                    <button className="btn btn-primary" onClick={() => setEditing({})}>Aggiungi Assenza</button>
                </div>
            </div>
            {editing && (
                <div className="card mt-1">
                    <h4>{editing.id ? 'Modifica' : 'Aggiungi'} Assenza</h4>
                    <div className="input-group">
                        <label>Personale</label>
                        <select className="select-field" value={editing.personnelId || ''} onChange={e => setEditing(p => ({...p, personnelId: e.target.value}))}>
                            <option value="">Seleziona...</option>
                            {data.personnel.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                     <div className="input-group">
                        <label>Tipo</label>
                        <select className="select-field" value={editing.typeId || ''} onChange={e => setEditing(p => ({...p, typeId: e.target.value}))}>
                            <option value="">Seleziona...</option>
                            {data.absenceTypes.filter(at => at.id !== 'fisse').map(at => <option key={at.id} value={at.id}>{at.name}</option>)}
                        </select>
                    </div>
                     <div className="input-group">
                        <label>Data Inizio</label>
                        <input type="date" className="input-field" value={editing.startDate || ''} onChange={e => setEditing(p => ({...p, startDate: e.target.value}))} />
                    </div>
                     <div className="input-group">
                        <label>Data Fine</label>
                        <input type="date" className="input-field" value={editing.endDate || ''} onChange={e => setEditing(p => ({...p, endDate: e.target.value}))} />
                    </div>
                    <div className="modal-footer" style={{padding:0, justifyContent: 'flex-end'}}><div>
                        <button className="btn btn-secondary" onClick={() => setEditing(null)}>Annulla</button>
                        <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                    </div></div>
                </div>
            )}
            <table className="data-table">
                <thead><tr><th>Personale</th><th>Tipo</th><th>Da</th><th>A</th><th></th></tr></thead>
                <tbody>
                    {data.absences.map(absence => (
                        <tr key={absence.id}>
                            <td>{data.personnel.find(p => p.id === absence.personnelId)?.name}</td>
                            <td>{data.absenceTypes.find(at => at.id === absence.typeId)?.name}</td>
                            <td>{new Date(absence.startDate + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                            <td>{new Date(absence.endDate + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                            <td style={{textAlign: 'right'}}>
                                <button className="btn btn-secondary" onClick={() => setEditing(absence)}>Modifica</button>
                                <button className="btn btn-danger" style={{marginLeft: '0.5rem'}} onClick={() => setAbsenceToDelete(absence)}>Elimina</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {unprocessedAbsences.length > 0 && (
                <div className="unprocessed-imports">
                    <div className="d-flex justify-between align-center">
                        <h4>Importazioni Fallite</h4>
                        <button className="btn btn-primary" onClick={handleReprocess}>Ritenta Importazione</button>
                    </div>
                    <p className="text-secondary">Queste assenze non sono state importate perché la sigla non è stata trovata o era assente. Aggiorna l'anagrafica e ritenta.</p>
                     <table className="data-table">
                        <thead><tr><th>Oggetto</th><th>Da</th><th>A</th><th>Motivo</th><th></th></tr></thead>
                        <tbody>
                            {unprocessedAbsences.map(item => (
                                <tr key={item.id}>
                                    <td>{item.summary}</td>
                                    <td>{new Date(item.startDate + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                                    <td>{new Date(item.endDate + 'T00:00:00').toLocaleDateString('it-IT')}</td>
                                    <td>{item.failureReason}</td>
                                    <td style={{textAlign: 'right'}}>
                                        <button className="btn btn-danger" onClick={() => setUnprocessedToDelete(item)}>Elimina</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <ConfirmationModal
                isOpen={!!absenceToDelete}
                onClose={() => setAbsenceToDelete(null)}
                onConfirm={handleConfirmAbsenceDelete}
                title="Conferma Eliminazione"
            >
                {personForAbsence && absenceToDelete ? (
                    <p>Sei sicuro di voler eliminare l'assenza di <strong>{personForAbsence.name}</strong> dal {new Date(absenceToDelete.startDate + 'T00:00:00').toLocaleDateString('it-IT')} al {new Date(absenceToDelete.endDate + 'T00:00:00').toLocaleDateString('it-IT')}?</p>
                ) : (
                    <p>Sei sicuro di voler eliminare questa assenza?</p>
                )}
                <p className="text-danger">Questa azione non può essere annullata.</p>
            </ConfirmationModal>

            <ConfirmationModal
                isOpen={!!unprocessedToDelete}
                onClose={() => setUnprocessedToDelete(null)}
                onConfirm={handleConfirmUnprocessedDelete}
                title="Conferma Eliminazione"
            >
                <p>Sei sicuro di voler eliminare la voce non processata "<strong>{unprocessedToDelete?.summary}</strong>"?</p>
                <p className="text-danger">Questa azione non può essere annullata.</p>
            </ConfirmationModal>
        </div>
    );
};

// --- DYNAMIC STATUS PICKER ---
interface StatusPickerProps {
    onClose: () => void;
    onSelect: (typeId: string) => void;
    absenceTypes: AbsenceType[];
    position: { top: number, left: number };
}
const StatusPicker: React.FC<StatusPickerProps> = ({ onClose, onSelect, absenceTypes, position }) => {
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (!target.closest('.status-picker')) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    return (
        <div className="status-picker" style={{ top: position.top, left: position.left }}>
            <ul>
                <li onClick={() => onSelect('present')}>
                     <span className="status-present override"></span> Presente
                </li>
                {absenceTypes.map(type => (
                    <li key={type.id} onClick={() => onSelect(type.id)}>
                        <span className="color-dot" style={{backgroundColor: type.color}}></span>
                        {type.name}
                    </li>
                ))}
                <li className="separator"></li>
                <li onClick={() => onSelect('reset')}>Ripristina</li>
            </ul>
        </div>
    );
};


// --- BOOKING MODAL ---
interface BookingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (booking: Booking) => void;
    onDelete: (bookingId: string) => void;
    instrument: Instrument;
    personnelList: Personnel[];
    date: string;
    slot: 'M' | 'P';
    isPersonAbsent: (personnelId: string, date: string, slot: 'M' | 'P') => boolean;
    existingBooking?: Booking;
}

const BookingModal: React.FC<BookingModalProps> = ({ isOpen, onClose, onSave, onDelete, instrument, personnelList, date, slot, isPersonAbsent, existingBooking }) => {
    const [personnelId, setPersonnelId] = useState(existingBooking?.personnelId || '');
    const [note, setNote] = useState(existingBooking?.note || '');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isAbsent = useMemo(() => personnelId && isPersonAbsent(personnelId, date, slot), [personnelId, date, slot, isPersonAbsent]);
    
    useEffect(() => {
        setPersonnelId(existingBooking?.personnelId || '');
        setNote(existingBooking?.note || '');
    }, [existingBooking]);

    const handleSave = () => {
        if (!personnelId) {
            alert("Selezionare il personale.");
            return;
        }
        if (isAbsent) {
            if (!confirm("Attenzione: la persona selezionata risulta assente. Continuare con la prenotazione?")) {
                return;
            }
        }
        onSave({
            id: existingBooking?.id || Date.now().toString(),
            instrumentId: instrument.id,
            personnelId,
            date,
            slot,
            note
        });
    };
    
    const handleConfirmDelete = () => {
        if (existingBooking) {
            onDelete(existingBooking.id);
        }
    };
    
    if (!isOpen) return null;

    return (
        <>
            <div className="modal-overlay" onClick={onClose}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <div className="modal-header">
                        <h2>Prenota {instrument.name}</h2>
                        <p>{new Date(date + 'T00:00:00').toLocaleDateString('it-IT', {weekday: 'long', day: 'numeric', month: 'long'})} - Slot: {slot === 'M' ? 'Mattina' : 'Pomeriggio'}</p>
                    </div>
                    <div className="modal-body">
                        <div className="input-group">
                            <label htmlFor="personnel">Assegna a:</label>
                            <select
                                id="personnel"
                                className="select-field"
                                value={personnelId}
                                onChange={(e) => setPersonnelId(e.target.value)}
                            >
                                <option value="">Seleziona personale...</option>
                                {personnelList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                             {isAbsent && <div className="alert-message alert-danger">Attenzione: Questa persona risulta assente in questo slot.</div>}
                        </div>
                        <div className="input-group">
                            <label htmlFor="note">Nota (opzionale):</label>
                            <textarea
                                id="note"
                                className="textarea-field"
                                value={note}
                                onChange={e => setNote(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="modal-footer">
                         {existingBooking ? 
                            <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>Elimina Prenotazione</button> 
                            : <div></div>}
                        <div>
                            <button className="btn btn-secondary" onClick={onClose}>Annulla</button>
                            <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                        </div>
                    </div>
                </div>
            </div>
            <ConfirmationModal
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleConfirmDelete}
                title="Conferma Eliminazione"
            >
                <p>Sei sicuro di voler eliminare questa prenotazione per <strong>{instrument.name}</strong>?</p>
                <p className="text-danger">Questa azione non può essere annullata.</p>
            </ConfirmationModal>
        </>
    );
};

// --- CUSTOM FORM COMPONENTS ---
const ColorPicker: React.FC<{ value: string; onChange: (color: string) => void }> = ({ value, onChange }) => {
    const colorPalette = [
        '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
        '#009688', '#4caf50', '#8bc34a', '#cddc39', '#ffeb3b', '#ffc107', '#ff9800', '#ff5722',
        '#795548', '#9e9e9e', '#607d8b', '#000000'
    ];
    return (
        <div className="color-palette">
            {colorPalette.map(color => (
                <div
                    key={color}
                    className={`color-swatch ${value === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => onChange(color)}
                    title={color}
                />
            ))}
        </div>
    );
};

const IconPickerTrigger: React.FC<{ value: string; onChange: (icon: string) => void }> = ({ value, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div>
            <div className="icon-picker-trigger">
                <div className="icon-preview">
                    <span className="material-symbols-outlined">{value || 'help'}</span>
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setIsOpen(true)}>Cambia Icona</button>
            </div>
            {isOpen && <IconPickerModal isOpen={isOpen} onClose={() => setIsOpen(false)} onSelect={icon => { onChange(icon); setIsOpen(false); }} />}
        </div>
    );
};

const IconPickerModal: React.FC<{ isOpen: boolean; onClose: () => void; onSelect: (icon: string) => void }> = ({ isOpen, onClose, onSelect }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const allIcons = useMemo(() => [
        // Lab - General & Chemistry
        'science', 'biotech', 'microscope', 'flask', 'test_tube', 'experiment', 'lab_profile', 'chemistry', 'genetics', 'dna', 'bubble_chart', 'flowsheet',
        
        // Lab - Measurement & Analysis
        'scale', 'thermometer', 'monitoring', 'analytics', 'calculate', 'query_stats', 'troubleshoot', 'insights', 'stacked_line_chart', 'ssid_chart', 'scatter_plot', 'colorize', 'functions',
        
        // Lab - Equipment & Processes
        'filter_alt', 'water_filter', 'compress', 'sensors', 'bolt', 'factory', 'heat_pump', 'build', 'blender', 'construction', 'settings',
        
        // Environment & Nature
        'eco', 'grass', 'forest', 'park', 'compost', 'agritech', 'water_drop', 'air', 'waves', 'water', 'tsunami', 'volcano', 'cyclone', 'flood', 'water_damage', 'public', 'dew_point', 'humidity_high',
        
        // Medical & Biology
        'medication', 'vaccines', 'coronavirus', 'microbiology', 'bloodtype', 'health_and_safety', 'local_pharmacy', 'nutrition', 'cardiology', 'neurology', 'orthopedics', 'pediatrics', 'psychology', 'radiology', 'ophthalmology',
        
        // Technology & Data
        'computer', 'database', 'storage', 'cloud', 'api', 'terminal', 'dns', 'hub', 'lan', 'memory', 'power',
        
        // Misc
        'package_2', 'bug_report', 'history', 'lightbulb', 'emergency', 'grain', 'gas_meter', 'legend_toggle'
    ].sort(), []);
    const filteredIcons = useMemo(() => allIcons.filter(icon => icon.includes(searchTerm.toLowerCase())), [searchTerm, allIcons]);
    
    if(!isOpen) return null;
    
    return (
        <div className="modal-overlay icon-picker-modal" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Seleziona Icona</h2>
                </div>
                <div className="modal-body">
                    <input 
                        type="text" 
                        className="input-field" 
                        placeholder="Cerca icona..." 
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                    />
                    <div className="icon-grid">
                        {filteredIcons.map(icon => (
                            <div key={icon} className="icon-grid-item" onClick={() => onSelect(icon)}>
                                <span className="material-symbols-outlined">{icon}</span>
                                <span className="icon-name">{icon}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="modal-footer">
                    <div></div>
                    <button className="btn btn-secondary" onClick={onClose}>Chiudi</button>
                </div>
            </div>
        </div>
    )
};


const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
