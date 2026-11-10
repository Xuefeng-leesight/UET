from django import forms

from apps.customers.models import CustomerEyeTracker
from apps.customers.secrets import normalize_softdog_password


class CustomerEyeTrackerForm(forms.ModelForm):
    softdog_password = forms.CharField(
        label="softdog pwd",
        required=False,
        min_length=32,
        max_length=512,
        widget=forms.PasswordInput(render_value=False),
        help_text="保存后不回显明文；留空表示不修改现有密钥。",
    )

    class Meta:
        model = CustomerEyeTracker
        exclude = ["softdog_password_ciphertext", "softdog_password_fingerprint"]

    def clean_softdog_password(self):
        value = self.cleaned_data.get("softdog_password", "")
        if not value:
            if not self.instance.pk:
                raise forms.ValidationError("新增设备时必须填写 softdog pwd。")
            return ""
        return normalize_softdog_password(value)

    def save(self, commit=True):
        instance = super().save(commit=False)
        password = self.cleaned_data.get("softdog_password", "")
        if password:
            instance.set_softdog_password(password)
        if commit:
            instance.save()
            self.save_m2m()
        return instance
