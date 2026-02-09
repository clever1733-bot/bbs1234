import Input from '../ui/Input';

function PatientInfoForm({
  patientInfo,
  onChange,
  accentColor = 'emerald',
  className = ''
}) {
  const handleChange = (field) => (e) => {
    onChange({ ...patientInfo, [field]: e.target.value });
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="grid md:grid-cols-2 gap-4">
        <Input
          label="환자 이름"
          type="text"
          value={patientInfo.name}
          onChange={handleChange('name')}
          placeholder="홍길동"
          accentColor={accentColor}
        />
        <Input
          label="환자 ID"
          type="text"
          value={patientInfo.id}
          onChange={handleChange('id')}
          placeholder="P-12345"
          accentColor={accentColor}
        />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Input
          label="키 (cm)"
          type="number"
          value={patientInfo.height || ''}
          onChange={handleChange('height')}
          placeholder="170"
          accentColor={accentColor}
          required
        />
      </div>
    </div>
  );
}

export default PatientInfoForm;
