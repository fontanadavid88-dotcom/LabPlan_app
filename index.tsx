import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

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
}

interface Instrument {
    id: string;
    name: string;
    categoryId: string;
    location: string;
    saNumber: string;
}

interface Personnel {
    id:string;
    name: string;
    initials: string;
    workPercentage: number;
    fixedAbsences: { [day: number]: { M?: string; P?: string } };
    color: string;
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
}

interface Booking {
    id: string;
    instrumentId: string;
    personnelId: string;
    date: string; // YYYY-MM-DD
    slot: 'M' | 'P';
    note?: string;
}

interface TemplateBooking {
    instrumentId: string;
    personnelId: string;
    dayOfWeek: number; // 0-4 for Mon-Fri
    slot: 'M' | 'P';
    note?: string;
}

interface Template {
    id: string;
    name: string;
    bookings: TemplateBooking[];
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

type View = 'dashboard' | 'dataManagement';
type DataManagementTab = 'instruments' | 'instrumentCategories' | 'personnel' | 'absences' | 'absenceTypes' | 'campaigns' | 'campaignCategories';
type DashboardTab = 'instruments' | 'personnel';

// --- UTILITY FUNCTIONS ---
const getISOWeek = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
};

const getWeekStartDate = (year: number, week: number) => {
    const d = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 1 - day);
    return d;
};

const formatDate = (date: Date) => date.toISOString().split('T')[0];

const addDays = (date: Date, days: number) => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
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
                    const endDate = new Date(endDateStr + 'T00:00:00Z');
                    endDate.setUTCDate(endDate.getUTCDate() - 1);
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


// --- DATA PERSISTENCE ---
const LOCAL_STORAGE_KEY = 'labPlannerData';

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
    return initialData;
};

const saveData = (data: AppData) => {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        console.error("Failed to save data to localStorage", error);
    }
};

// --- MAIN APP COMPONENT ---
const App: React.FC = () => {
    const [data, setData] = useState<AppData>(loadData);
    const [view, setView] = useState<View>('dashboard');
    const logoUploadRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        saveData(data);
    }, [data]);

    const handleDataChange = <K extends keyof AppData>(key: K, value: AppData[K]) => {
        setData(prevData => ({ ...prevData, [key]: value }));
    };

    const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
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
        logoUploadRef.current?.click();
    };

    return (
        <>
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
                <nav className="nav-buttons">
                    <button onClick={() => setView('dashboard')} className={view === 'dashboard' ? 'active' : ''}>Dashboard</button>
                    <button onClick={() => setView('dataManagement')} className={view === 'dataManagement' ? 'active' : ''}>Anagrafica</button>
                </nav>
            </header>
            <main className="app-container">
                {view === 'dashboard' && (
                    <DashboardView
                        data={data}
                        setData={setData}
                    />
                )}
                {view === 'dataManagement' && (
                    <DataManagementView
                        data={data}
                        onDataChange={handleDataChange}
                    />
                )}
            </main>
        </>
    );
};

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
                    <p>{new Date(date).toLocaleString('it-IT', {weekday: 'long', day: 'numeric', month: 'long'})} - Slot: {slot === 'M' ? 'Mattina' : 'Pomeriggio'}</p>
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
}> = ({ person, date, slot, data, getAbsenceDetails, onAddBooking }) => {
    const dateStr = formatDate(date);
    const key = `${person.id}-${dateStr}-${slot}`;
    const overrideTypeId = data.statusOverrides[key];
    
    let absenceDetails: AbsenceType | null = null;
    let content: React.ReactNode = null;
    let style: React.CSSProperties = {};
    let className = `personnel-schedule-cell ${slot === 'P' ? 'afternoon' : ''}`;
    let isClickable = false;

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
        const booking = data.bookings.find(b => b.personnelId === person.id && b.date === dateStr && b.slot === slot);
        if (booking) {
            const instrument = data.instruments.find(i => i.id === booking.instrumentId);
            style = { backgroundColor: person.color };
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
            className += ' booked';
        } else {
            // Free slot
            isClickable = true;
            className += ' free';
        }
    }

    return (
        <td
            style={style}
            className={className}
            onClick={isClickable ? () => onAddBooking({ personnelId: person.id, date: dateStr, slot }) : undefined}
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
}> = ({ data, weekDates, getAbsenceDetails, onAddBooking }) => {
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
                                    />
                                    <PersonnelScheduleCell
                                        person={person}
                                        date={date}
                                        slot="P"
                                        data={data}
                                        getAbsenceDetails={getAbsenceDetails}
                                        onAddBooking={onAddBooking}
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
}

const DashboardView: React.FC<DashboardViewProps> = ({ data, setData }) => {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [dashboardTab, setDashboardTab] = useState<DashboardTab>('instruments');
    const [bookingModal, setBookingModal] = useState<{ instrumentId: string; date: string; slot: 'M' | 'P' } | null>(null);
    const [quickBookingModal, setQuickBookingModal] = useState<{ personnelId: string; date: string; slot: 'M' | 'P' } | null>(null);
    const [editingStatus, setEditingStatus] = useState<{ key: string, top: number, left: number } | null>(null);
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

    const year = currentDate.getFullYear();
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
        const dayOfWeek = (date.getDay() + 6) % 7; // Monday is 0
        const fixedAbsenceTypeId = person.fixedAbsences?.[dayOfWeek]?.[slot];
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

    const handleSaveTemplate = () => {
        const templateName = prompt("Inserisci il nome del template:");
        if (!templateName) return;

        const weekDateStrings = weekDates.map(formatDate);
        const bookingsInWeek = data.bookings.filter(b => weekDateStrings.includes(b.date));
        
        const templateBookings: TemplateBooking[] = bookingsInWeek.map(b => {
            const date = new Date(b.date);
            const dayOfWeek = (date.getDay() + 6) % 7;
            return {
                instrumentId: b.instrumentId,
                personnelId: b.personnelId,
                dayOfWeek: dayOfWeek,
                slot: b.slot,
                note: b.note,
            };
        });

        const newTemplate: Template = {
            id: Date.now().toString(),
            name: templateName,
            bookings: templateBookings,
        };

        setData(prev => ({
            ...prev,
            templates: [...(prev.templates || []), newTemplate],
        }));
        alert(`Template "${templateName}" salvato!`);
    };

    const handleApplyTemplate = () => {
        if (!selectedTemplateId) {
            alert("Seleziona un template da applicare.");
            return;
        }
        if (!confirm("Applicando questo template, tutte le prenotazioni della settimana corrente verranno sostituite. Continuare?")) {
            return;
        }

        const template = data.templates?.find(t => t.id === selectedTemplateId);
        if (!template) return;

        const weekDateStrings = weekDates.map(formatDate);
        const bookingsOutsideWeek = data.bookings.filter(b => !weekDateStrings.includes(b.date));

        const newBookingsFromTemplate: Booking[] = template.bookings.map(tb => {
            const date = addDays(weekStartDate, tb.dayOfWeek);
            return {
                id: `${Date.now()}-${Math.random()}`,
                instrumentId: tb.instrumentId,
                personnelId: tb.personnelId,
                date: formatDate(date),
                slot: tb.slot,
                note: tb.note,
            };
        });

        setData(prev => ({
            ...prev,
            bookings: [...bookingsOutsideWeek, ...newBookingsFromTemplate],
        }));
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

    const activeCampaigns = useMemo(() => {
        const weekStartStr = formatDate(weekDates[0]);
        const weekEndStr = formatDate(weekDates[4]);
        return data.campaigns.filter(c => c.startDate <= weekEndStr && c.endDate >= weekStartStr);
    }, [data.campaigns, weekDates]);

    return (
        <div>
            <div className="card">
                <div className="d-flex justify-between align-center">
                    <button className="btn btn-secondary" onClick={() => setCurrentDate(addDays(currentDate, -7))}>&larr; Precedente</button>
                    <div className="text-center">
                        <h2 className="mb-0">SETTIMANA {week}</h2>
                        <p className="text-secondary">{weekStartDate.toLocaleDateString('it-IT')} - {addDays(weekStartDate, 4).toLocaleDateString('it-IT')}</p>
                    </div>
                    <button className="btn btn-secondary" onClick={() => setCurrentDate(addDays(currentDate, 7))}>Successivo &rarr;</button>
                </div>
                <div className="template-manager">
                    <select className="select-field" value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
                        <option value="">Seleziona un template...</option>
                        {(data.templates || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button className="btn btn-secondary" onClick={handleApplyTemplate} disabled={!selectedTemplateId}>Applica</button>
                    <button className="btn btn-primary" onClick={handleSaveTemplate}>Salva come Template</button>
                </div>
            </div>

            <div className="view-switcher nav-buttons mb-1">
                <button onClick={() => setDashboardTab('instruments')} className={dashboardTab === 'instruments' ? 'active' : ''}>
                    <span className="material-symbols-outlined">science</span> Vista Strumenti
                </button>
                <button onClick={() => setDashboardTab('personnel')} className={dashboardTab === 'personnel' ? 'active' : ''}>
                    <span className="material-symbols-outlined">groups</span> Vista Personale
                </button>
            </div>

            {dashboardTab === 'instruments' && (
                <>
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
                                {activeCampaigns.map((campaign, index) => {
                                    const category = data.campaignCategories.find(cc => cc.id === campaign.categoryId);
                                    const campaignCells: React.ReactNode[] = [];
                                    let i = 0;
                                    let nameRendered = false; // Render name only in the first active block
                                    while (i < weekDates.length) {
                                        const date = weekDates[i];
                                        const dateStr = formatDate(date);
                                        const isActive = dateStr >= campaign.startDate && dateStr <= campaign.endDate;
                                        if (isActive) {
                                            let span = 1;
                                            while (i + span < weekDates.length && formatDate(weekDates[i + span]) <= campaign.endDate) {
                                                span++;
                                            }
                                            campaignCells.push(
                                                <td key={dateStr} colSpan={span * 2} className="campaign-cell-active" style={{ backgroundColor: category?.color || '#cccccc' }}>
                                                    {!nameRendered && (
                                                        <div className="campaign-cell-content">
                                                            <span className="material-symbols-outlined">{category?.icon || 'campaign'}</span>
                                                            {campaign.name}
                                                        </div>
                                                    )}
                                                </td>
                                            );
                                            nameRendered = true;
                                            i += span;
                                        } else {
                                            campaignCells.push(<td key={dateStr} colSpan={2}></td>);
                                            i++;
                                        }
                                    }
                                    return (
                                        <tr key={campaign.id} className="campaign-row">
                                            <td colSpan={3} className="campaign-header-cell">
                                                {index === 0 ? '🧪 CAMPAGNE' : ''}
                                            </td>
                                            {campaignCells}
                                        </tr>
                                    );
                                })}
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
                                                                <BookingCell date={dateStr} slot="M" instrument={instrument} data={data} setBookingModal={setBookingModal} />
                                                                <BookingCell date={dateStr} slot="P" instrument={instrument} data={data} setBookingModal={setBookingModal} />
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
                                                            <BookingCell date={dateStr} slot="M" instrument={instrument} data={data} setBookingModal={setBookingModal} />
                                                            <BookingCell date={dateStr} slot="P" instrument={instrument} data={data} setBookingModal={setBookingModal} />
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
                                                        <span>{new Date(booking.date).toLocaleDateString('it-IT', { weekday: 'short' })} ({booking.slot})</span>
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
                
                    <div className="card">
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
                />
            )}

            <div className="card">
                <h3>NOTE SETTIMANALI</h3>
                <textarea 
                    className="textarea-field"
                    placeholder="Note generali per la settimana..."
                    value={data.weeklyNotes[weekKey] || ''}
                    onChange={(e) => setWeeklyNote(e.target.value)}
                />
            </div>

            {editingStatus && (
                <StatusPicker
                    onClose={() => setEditingStatus(null)}
                    onSelect={(typeId) => handleStatusChange(editingStatus.key, typeId)}
                    absenceTypes={data.absenceTypes.filter(at => at.id !== 'fisse')}
                    position={editingStatus}
                />
            )}
            
            {bookingModal &&
                <BookingModal
                    isOpen={!!bookingModal}
                    onClose={() => setBookingModal(null)}
                    onSave={handleSaveBooking}
                    onDelete={handleDeleteBooking}
                    instrument={data.instruments.find(i => i.id === bookingModal.instrumentId)!}
                    personnelList={data.personnel}
                    date={bookingModal.date}
                    slot={bookingModal.slot}
                    isPersonAbsent={(personnelId, date, slot) => !!getAbsenceDetails(personnelId, new Date(date), slot)}
                    existingBooking={data.bookings.find(b => b.instrumentId === bookingModal.instrumentId && b.date === bookingModal.date && b.slot === bookingModal.slot)}
                />
            }

            {quickBookingModal &&
                <QuickAddBookingModal
                    isOpen={!!quickBookingModal}
                    onClose={() => setQuickBookingModal(null)}
                    onSave={handleSaveBooking}
                    personnel={data.personnel.find(p => p.id === quickBookingModal.personnelId)!}
                    instrumentList={data.instruments}
                    date={quickBookingModal.date}
                    slot={quickBookingModal.slot}
                    isPersonAbsent={(personnelId, date, slot) => !!getAbsenceDetails(personnelId, new Date(date), slot)}
                />
            }
        </div>
    );
};

const PersonnelStatusCell: React.FC<{
    personId: string,
    date: Date,
    slot: 'M' | 'P',
    data: AppData,
    getAbsenceDetails: (personnelId: string, date: Date, slot: 'M' | 'P') => AbsenceType | null,
    onEdit: (event: React.MouseEvent<HTMLTableCellElement>) => void
}> = ({ personId, date, slot, data, getAbsenceDetails, onEdit }) => {
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

    return (
         <td
            className={`status-cell ${slot === 'P' ? 'afternoon' : ''}`}
            style={style}
            onClick={onEdit}
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
}> = ({ date, slot, instrument, data, setBookingModal }) => {
    const booking = data.bookings.find(b => b.instrumentId === instrument.id && b.date === date && b.slot === slot);
    const person = booking ? data.personnel.find(p => p.id === booking.personnelId) : null;
    const style = person ? { backgroundColor: person.color } : {};

    return (
        <td
            style={style}
            className={`booking-cell ${slot === 'P' ? 'afternoon' : ''} ${person ? 'booked' : ''}`}
            onClick={() => setBookingModal({ instrumentId: instrument.id, date, slot })}
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


const DataManagementView: React.FC<DataManagementViewProps> = ({ data, onDataChange }) => {
    const [tab, setTab] = useState<DataManagementTab>('instruments');
    
    const CrudComponent = <T extends { id: string } & Record<string, any>>({ name, items, setItems, fields, data, onImportICS }: {
        name: string;
        items: T[];
        setItems: (items: T[]) => void;
        fields: { key: keyof T, label: string, type: string, options?: any, props?: any }[];
        data?: AppData;
        onImportICS?: (fileContent: string) => void;
    }) => {
        const [editing, setEditing] = useState<Partial<T> | null>(null);
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
                                    <button className="btn btn-danger" style={{marginLeft: '0.5rem'}} onClick={() => setItems(items.filter(i => (i as any).id !== item.id))}>Elimina</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    const handleCampaignsImport = (fileContent: string) => {
        try {
            const events = parseICS(fileContent);
            const newCampaigns: Campaign[] = events.map(event => ({
                id: `${Date.now()}-${Math.random()}`,
                name: event.summary,
                startDate: event.startDate,
                endDate: event.endDate,
                categoryId: '',
            }));

            if(newCampaigns.length > 0) {
                 onDataChange('campaigns', [...data.campaigns, ...newCampaigns]);
                 alert(`${newCampaigns.length} campagne importate con successo. Ricorda di assegnare le categorie.`);
            } else {
                 alert("Nessun evento valido trovato nel file ICS.");
            }
        } catch (error) {
            alert("Errore durante l'importazione del file ICS.");
            console.error(error);
        }
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
            </div>
            
            {tab === 'instruments' && <CrudComponent name="Strumento" items={data.instruments} setItems={(items) => onDataChange('instruments', items)} fields={[
                 { key: 'name', label: 'Nome', type: 'text' },
                 { key: 'categoryId', label: 'Categoria', type: 'select', options: [{label: 'Seleziona...', value: ''}, ...data.instrumentCategories.map(c => ({label: c.name, value: c.id}))] },
                 { key: 'location', label: 'Locale', type: 'text' },
                 { key: 'saNumber', label: 'Numero SA', type: 'text' },
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
                { key: 'fixedAbsences', label: 'Assenze Fisse Settimanali', type: 'fixed-absence-editor' }
            ]} />}

            {tab === 'absences' && <AbsenceManager data={data} onDataChange={onDataChange} />}

            {tab === 'absenceTypes' && <CrudComponent name="Tipo Assenza" items={data.absenceTypes} setItems={(items) => onDataChange('absenceTypes', items)} fields={[
                { key: 'name', label: 'Nome', type: 'text' },
                { key: 'color', label: 'Colore', type: 'color-palette' },
            ]} />}
            
            {tab === 'campaigns' && <CrudComponent 
                name="Campagna" 
                items={data.campaigns} 
                setItems={(items) => onDataChange('campaigns', items)} 
                fields={[
                    { key: 'name', label: 'Nome', type: 'text' },
                    { key: 'categoryId', label: 'Categoria', type: 'select', options: [{label: 'Seleziona...', value: ''}, ...data.campaignCategories.map(c => ({label: c.name, value: c.id}))] },
                    { key: 'startDate', label: 'Data Inizio', type: 'date' },
                    { key: 'endDate', label: 'Data Fine', type: 'date' },
                ]}
                onImportICS={handleCampaignsImport}
            />}

             {tab === 'campaignCategories' && <CrudComponent name="Categoria Campagna" items={data.campaignCategories} setItems={(items) => onDataChange('campaignCategories', items)} fields={[
                 { key: 'name', label: 'Nome', type: 'text' },
                 { key: 'icon', label: 'Icona', type: 'icon-picker' },
                 { key: 'color', label: 'Colore', type: 'color-palette' },
            ]} />}
        </div>
    );
};

// --- ABSENCE MANAGER ---
const AbsenceManager: React.FC<DataManagementViewProps> = ({ data, onDataChange }) => {
    const [editing, setEditing] = useState<Partial<Absence> | null>(null);
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
                            <td>{new Date(absence.startDate).toLocaleDateString('it-IT')}</td>
                            <td>{new Date(absence.endDate).toLocaleDateString('it-IT')}</td>
                            <td style={{textAlign: 'right'}}>
                                <button className="btn btn-secondary" onClick={() => setEditing(absence)}>Modifica</button>
                                <button className="btn btn-danger" style={{marginLeft: '0.5rem'}} onClick={() => onDataChange('absences', data.absences.filter(a => (a as any).id !== absence.id))}>Elimina</button>
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
                                    <td>{new Date(item.startDate).toLocaleDateString('it-IT')}</td>
                                    <td>{new Date(item.endDate).toLocaleDateString('it-IT')}</td>
                                    <td>{item.failureReason}</td>
                                    <td style={{textAlign: 'right'}}>
                                        <button className="btn btn-danger" onClick={() => onDataChange('unprocessedAbsences', unprocessedAbsences.filter(u => u.id !== item.id))}>Elimina</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
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
    
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Prenota {instrument.name}</h2>
                    <p>{new Date(date).toLocaleDateString('it-IT', {weekday: 'long', day: 'numeric', month: 'long'})} - Slot: {slot === 'M' ? 'Mattina' : 'Pomeriggio'}</p>
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
                        <button className="btn btn-danger" onClick={() => onDelete(existingBooking.id)}>Elimina Prenotazione</button> 
                        : <div></div>}
                    <div>
                        <button className="btn btn-secondary" onClick={onClose}>Annulla</button>
                        <button className="btn btn-primary" onClick={handleSave}>Salva</button>
                    </div>
                </div>
            </div>
        </div>
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